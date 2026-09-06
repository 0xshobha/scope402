import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { DemoRunError, type DemoRunLimits } from './demo-runs.js'
import { HostedAgentGuard, HostedAgentLimitError } from './hosted-payment-guard.js'
import { ExactPaymentDeliveryError } from './payment-client.js'
import { ephemeralSubject, type AgentSubject } from './subject.js'
import type { PublicTesseraCapability, TesseraActionName, TesseraActionResult,
  TesseraCapabilitySession } from './tessera-capability.js'
import type { PreparedPlot, TesseraPlotResult } from './tessera-purchase.js'

export type TesseraRunState = 'PAYMENT_REQUIRED' | 'PAYMENT_RECOVERY' | 'SETTLING' | 'ROOT_ACTIVE' |
  'ACTION_PENDING' | 'CHILD_ACTIVE' | 'COMPLETE' | 'FAILED'

export type PublicTesseraRun = {
  run_id: string
  state: TesseraRunState
  created_at: string
  expires_at: string
  mode: 'hosted-testnet-agent'
  quote: {
    canvas_id: 'main'
    region: PreparedPlot['quote']['region']
    pricing: PreparedPlot['quote']['pricing']
    policy_hash: string
    payer: string
    merchant: string
    network: 'hedera:testnet'
    asset: '0.0.0'
  }
  payment?: TesseraPlotResult['payment']
  root?: PublicTesseraCapability
  child?: PublicTesseraCapability
  actions: TesseraActionResult[]
  last_action?: TesseraActionResult
  error?: { code: string; message: string }
}

type InternalRun = {
  public: PublicTesseraRun
  ip: string
  tokenHash: Buffer
  prepared: PreparedPlot
  worker: AgentSubject
  result?: TesseraPlotResult
  capability?: TesseraCapabilitySession
  approval?: Promise<PublicTesseraRun>
  paymentAttempted?: boolean
  actionAttempts: Map<TesseraActionName, Promise<TesseraActionResult>>
  activeAction?: TesseraActionName
}

export type TesseraRunDependencies = {
  prepare(subject: AgentSubject): Promise<PreparedPlot>
  approve(prepared: PreparedPlot): Promise<{ result: TesseraPlotResult }>
  payerBalanceTinybars(): Promise<bigint>
  createCapabilitySession(prepared: PreparedPlot, result: TesseraPlotResult,
    worker: AgentSubject): TesseraCapabilitySession
  now?(): number
  logError?(message: string): void
}

const order: TesseraActionName[] = [
  'delegate', 'place-outside', 'wrong-key', 'place-inside', 'replay', 'expire',
]

export class TesseraRunService {
  private readonly runs = new Map<string, InternalRun>()

  constructor(private readonly dependencies: TesseraRunDependencies,
    private readonly limits: DemoRunLimits, private readonly guard: HostedAgentGuard) {}

  private now() {
    return this.dependencies.now?.() ?? Date.now()
  }

  async create(ip: string) {
    const now = this.now()
    const runId = randomUUID()
    const expiresAt = now + this.limits.runTtlMs
    try {
      this.guard.acquireRun(ip, runId, expiresAt)
    } catch (error) {
      if (error instanceof HostedAgentLimitError) {
        const active = error.message.includes('active')
        throw new DemoRunError(active ? 'DEMO_RUN_ACTIVE' : 'DEMO_RATE_LIMITED',
          active ? 409 : 429, error.message)
      }
      throw error
    }
    const principal = ephemeralSubject()
    const worker = ephemeralSubject()
    let prepared: PreparedPlot
    try {
      prepared = await this.dependencies.prepare(principal)
    } catch (error) {
      this.guard.releaseRun(runId, true)
      throw error
    }
    const token = randomBytes(32).toString('base64url')
    const publicRun: PublicTesseraRun = {
      run_id: runId,
      state: 'PAYMENT_REQUIRED',
      created_at: new Date(now).toISOString(),
      expires_at: new Date(expiresAt).toISOString(),
      mode: 'hosted-testnet-agent',
      quote: {
        canvas_id: 'main', region: prepared.quote.region, pricing: prepared.quote.pricing,
        policy_hash: prepared.quote.policy_hash, payer: prepared.payer,
        merchant: prepared.terms.payTo, network: 'hedera:testnet', asset: '0.0.0',
      },
      actions: [],
    }
    this.runs.set(runId, { public: publicRun, ip,
      tokenHash: createHash('sha256').update(token).digest(), prepared, worker,
      actionAttempts: new Map() })
    return { run: structuredClone(publicRun), run_token: token }
  }

  private authorized(runId: string, token: string) {
    const run = this.runs.get(runId)
    const actual = createHash('sha256').update(token).digest()
    if (!run || actual.length !== run.tokenHash.length || !timingSafeEqual(actual, run.tokenHash)) {
      throw new DemoRunError('DEMO_RUN_NOT_FOUND', 404, 'Tessera run was not found')
    }
    if (!run.result && Date.parse(run.public.expires_at) <= this.now()) {
      throw new DemoRunError('DEMO_RUN_EXPIRED', 410, 'Tessera payment approval window expired')
    }
    return run
  }

  get(runId: string, token: string) {
    return structuredClone(this.authorized(runId, token).public)
  }

  approve(runId: string, token: string) {
    const run = this.authorized(runId, token)
    if (run.result) return Promise.resolve(structuredClone(run.public))
    if (run.public.state === 'FAILED') {
      throw new DemoRunError('DEMO_APPROVAL_FAILED', 409, 'This Tessera run already attempted payment')
    }
    if (run.approval) return run.approval
    const amount = BigInt(run.prepared.terms.amount)
    if (!run.paymentAttempted) {
      try {
        this.guard.assertPaymentCapacity(amount)
      } catch (error) {
        if (error instanceof HostedAgentLimitError) {
          throw new DemoRunError('DEMO_SPEND_LIMITED', 429, error.message)
        }
        throw error
      }
    }
    run.public.state = 'SETTLING'
    run.approval = (async () => {
      try {
        let reservation: string | undefined
        if (!run.paymentAttempted) {
          const balance = await this.dependencies.payerBalanceTinybars()
          try {
            reservation = this.guard.reservePayment(run.prepared.payer, amount, balance,
              this.limits.minimumBalanceTinybars)
          } catch (error) {
            if (error instanceof HostedAgentLimitError) {
              const floor = error.message.includes('balance floor')
              throw new DemoRunError(floor ? 'DEMO_BALANCE_FLOOR' : 'DEMO_SPEND_LIMITED',
                floor ? 409 : 429, error.message)
            }
            throw error
          }
          run.paymentAttempted = true
        }
        let approved: { result: TesseraPlotResult }
        try {
          approved = await this.dependencies.approve(run.prepared)
        } finally {
          if (reservation) this.guard.finishPayment(reservation)
        }
        run.result = approved.result
        run.capability = this.dependencies.createCapabilitySession(run.prepared,
          approved.result, run.worker)
        run.public.payment = approved.result.payment
        run.public.root = run.capability.root()
        run.public.state = 'ROOT_ACTIVE'
        run.public.error = undefined
        return structuredClone(run.public)
      } catch (error) {
        this.dependencies.logError?.(error instanceof Error ? error.message : 'Unknown Tessera payment failure')
        if (error instanceof ExactPaymentDeliveryError) {
          run.approval = undefined
          run.public.state = 'PAYMENT_RECOVERY'
          run.public.error = { code: 'DEMO_PAYMENT_AMBIGUOUS',
            message: 'Payment delivery was ambiguous. Retry recovery with the same signed Hedera transaction.' }
          throw new DemoRunError('DEMO_PAYMENT_AMBIGUOUS', 502, run.public.error.message)
        }
        run.public.state = 'FAILED'
        run.public.error = { code: error instanceof DemoRunError ? error.code : 'DEMO_PAYMENT_FAILED',
          message: error instanceof Error ? error.message : 'Hosted Tessera agent failed' }
        this.guard.releaseRun(run.public.run_id, !run.paymentAttempted)
        if (error instanceof DemoRunError) throw error
        throw new DemoRunError('DEMO_PAYMENT_FAILED', 502,
          'Hosted Tessera agent could not complete payment')
      }
    })()
    return run.approval
  }

  action(runId: string, token: string, action: TesseraActionName) {
    const run = this.authorized(runId, token)
    if (!run.result || !run.capability) {
      throw new DemoRunError('DEMO_RUN_INCOMPLETE', 409,
        'Complete the Tessera payment before testing authority')
    }
    const index = order.indexOf(action)
    if (index < 0) throw new DemoRunError('DEMO_ACTION_NOT_FOUND', 404, 'Tessera action was not found')
    const completed = run.public.actions.find((item) => item.action === action)
    if (completed) return Promise.resolve(structuredClone(completed))
    const active = run.actionAttempts.get(action)
    if (active) return active
    if (run.activeAction) {
      throw new DemoRunError('DEMO_ACTION_BUSY', 409, 'Another Tessera action is still running')
    }
    const preceding = order.slice(0, index)
    if (preceding.some((name) => !run.public.actions.some((item) => item.action === name))) {
      throw new DemoRunError('DEMO_ACTION_ORDER', 409,
        `Run ${order[index - 1] ?? 'approval'} before ${action}`)
    }
    run.activeAction = action
    run.public.state = 'ACTION_PENDING'
    const attempt = run.capability.execute(action).then((result) => {
      run.public.actions.push(result)
      run.public.last_action = result
      run.public.root = run.capability!.root()
      run.public.child = run.capability!.child()
      run.public.state = action === 'expire' ? 'COMPLETE' :
        action === 'delegate' ? 'CHILD_ACTIVE' : 'CHILD_ACTIVE'
      run.activeAction = undefined
      if (action === 'expire') this.guard.releaseRun(run.public.run_id)
      return structuredClone(result)
    }).catch((error: unknown) => {
      run.activeAction = undefined
      run.actionAttempts.delete(action)
      run.public.state = run.public.child ? 'CHILD_ACTIVE' : 'ROOT_ACTIVE'
      this.dependencies.logError?.(error instanceof Error ? error.message : 'Unknown Tessera action failure')
      if (error instanceof DemoRunError) throw error
      throw new DemoRunError('DEMO_ACTION_FAILED', 502,
        error instanceof Error ? error.message : 'Hosted Tessera action failed')
    })
    run.actionAttempts.set(action, attempt)
    return attempt
  }
}
