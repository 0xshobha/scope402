import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { DemoActionName, DemoActionResult, DemoCapabilitySession } from './capability-demo.js'
import type { PreparedScan, ScanResult } from './purchase.js'
import { HostedAgentGuard, HostedAgentLimitError } from './hosted-payment-guard.js'
import { ExactPaymentDeliveryError } from './payment-client.js'

export type DemoState = 'PAYMENT_REQUIRED' | 'PAYMENT_RECOVERY' | 'SETTLING' | 'COMPLETE' | 'FAILED'

export type PublicRun = {
  run_id: string
  state: DemoState
  created_at: string
  expires_at: string
  mode: 'hosted-testnet-agent'
  quote: {
    repository: string
    commit_sha: string
    pricing: PreparedScan['quote']['pricing']
    payer: string
    merchant: string
    network: 'hedera:testnet'
    asset: '0.0.0'
  }
  result?: {
    scan_id: string
    findings: ScanResult['findings']
    payment: ScanResult['payment']
    lease: Omit<ScanResult['lease'], 'token'> & { remaining_calls: number }
  }
  actions?: Partial<Record<DemoActionName, DemoActionResult>>
  error?: { code: string; message: string }
}

type InternalRun = {
  public: PublicRun
  ip: string
  tokenHash: Buffer
  prepared: PreparedScan
  result?: ScanResult
  capability?: DemoCapabilitySession
  actionAttempts: Map<DemoActionName, Promise<DemoActionResult>>
  approval?: Promise<PublicRun>
  paymentAttempted?: boolean
}

export class DemoRunError extends Error {
  constructor(readonly code: string, readonly status: 400 | 401 | 404 | 409 | 410 | 429 | 502,
    message: string) {
    super(message)
  }
}

export type DemoRunLimits = {
  runTtlMs: number
  perIpRunsPerHour: number
  globalRunsPerHour: number
  globalApprovalsPerHour: number
  maxHourlySpendTinybars: bigint
  minimumBalanceTinybars: bigint
}

type Approval = { result: ScanResult }

export type DemoRunDependencies = {
  prepare(repoUrl: string): Promise<PreparedScan>
  approve(prepared: PreparedScan): Promise<Approval>
  payerBalanceTinybars(): Promise<bigint>
  createCapabilitySession?(prepared: PreparedScan, result: ScanResult): DemoCapabilitySession
  now?(): number
  logError?(message: string): void
}

const hourMs = 60 * 60 * 1_000

function publicResult(result: ScanResult): NonNullable<PublicRun['result']> {
  return {
    scan_id: result.scan_id,
    findings: result.findings.map(({ id, severity, message }) => ({ id, severity, message })),
    payment: {
      payer: result.payment.payer,
      merchant: result.payment.merchant,
      amount_tinybars: result.payment.amount_tinybars,
      transaction: result.payment.transaction,
      hashscan_url: result.payment.hashscan_url,
    },
    lease: {
      lease_id: result.lease.lease_id,
      subject_pubkey: result.lease.subject_pubkey,
      aud: result.lease.aud,
      tool_ids: ['finding_details'],
      max_calls: result.lease.max_calls,
      exp: result.lease.exp,
      hedera_tx_id: result.lease.hedera_tx_id,
      scan_id: result.lease.scan_id,
      remaining_calls: result.lease.max_calls,
    },
  }
}

export class DemoRunService {
  private readonly runs = new Map<string, InternalRun>()
  private readonly hostedGuard: HostedAgentGuard

  constructor(private readonly dependencies: DemoRunDependencies,
    private readonly limits: DemoRunLimits, hostedGuard?: HostedAgentGuard) {
    this.hostedGuard = hostedGuard ?? new HostedAgentGuard(limits, () => this.now())
  }

  private now() {
    return this.dependencies.now?.() ?? Date.now()
  }

  private trim(now: number) {
    for (const [id, run] of this.runs) {
      if (Date.parse(run.public.expires_at) + hourMs < now) this.runs.delete(id)
    }
  }

  private assertApprovalCapacity(amount: bigint) {
    try {
      this.hostedGuard.assertPaymentCapacity(amount)
    } catch (error) {
      if (error instanceof HostedAgentLimitError) {
        throw new DemoRunError('DEMO_SPEND_LIMITED', 429, error.message)
      }
      throw error
    }
  }

  async create(repoUrl: string, ip: string) {
    const now = this.now()
    this.trim(now)
    const runId = randomUUID()
    const token = randomBytes(32).toString('base64url')
    const expiresAt = now + this.limits.runTtlMs
    try {
      this.hostedGuard.acquireRun(ip, runId, expiresAt)
    } catch (error) {
      if (error instanceof HostedAgentLimitError) {
        const active = error.message.includes('active')
        throw new DemoRunError(active ? 'DEMO_RUN_ACTIVE' : 'DEMO_RATE_LIMITED',
          active ? 409 : 429, error.message)
      }
      throw error
    }
    let prepared: PreparedScan
    try {
      prepared = await this.dependencies.prepare(repoUrl)
    } catch (error) {
      this.hostedGuard.releaseRun(runId)
      throw error
    }
    const publicRun: PublicRun = {
      run_id: runId,
      state: 'PAYMENT_REQUIRED',
      created_at: new Date(now).toISOString(),
      expires_at: new Date(expiresAt).toISOString(),
      mode: 'hosted-testnet-agent',
      quote: {
        repository: prepared.quote.repository,
        commit_sha: prepared.quote.commit_sha,
        pricing: prepared.quote.pricing,
        payer: prepared.payer,
        merchant: prepared.terms.payTo,
        network: 'hedera:testnet',
        asset: '0.0.0',
      },
    }
    this.runs.set(runId, { public: publicRun, ip,
      tokenHash: createHash('sha256').update(token).digest(), prepared, actionAttempts: new Map() })
    return { run: structuredClone(publicRun), run_token: token }
  }

  private authorized(runId: string, token: string) {
    const run = this.runs.get(runId)
    const actual = createHash('sha256').update(token).digest()
    if (!run || actual.length !== run.tokenHash.length || !timingSafeEqual(actual, run.tokenHash)) {
      throw new DemoRunError('DEMO_RUN_NOT_FOUND', 404, 'Demo run was not found')
    }
    if (Date.parse(run.public.expires_at) <= this.now()) {
      throw new DemoRunError('DEMO_RUN_EXPIRED', 410, 'Demo run approval window expired')
    }
    return run
  }

  get(runId: string, token: string) {
    return structuredClone(this.authorized(runId, token).public)
  }

  approve(runId: string, token: string) {
    const run = this.authorized(runId, token)
    if (run.public.state === 'COMPLETE') return Promise.resolve(structuredClone(run.public))
    if (run.public.state === 'FAILED') {
      throw new DemoRunError('DEMO_APPROVAL_FAILED', 409, 'This run already attempted payment')
    }
    if (run.approval) return run.approval
    const amount = BigInt(run.prepared.terms.amount)
    if (!run.paymentAttempted) this.assertApprovalCapacity(amount)
    run.public.state = 'SETTLING'
    run.approval = (async () => {
      try {
        let reservation: string | undefined
        if (!run.paymentAttempted) {
          const balance = await this.dependencies.payerBalanceTinybars()
          try {
            reservation = this.hostedGuard.reservePayment(run.prepared.payer, amount, balance,
              this.limits.minimumBalanceTinybars)
          } catch (error) {
            if (error instanceof HostedAgentLimitError) {
              const balanceFloor = error.message.includes('balance floor')
              throw new DemoRunError(balanceFloor ? 'DEMO_BALANCE_FLOOR' : 'DEMO_SPEND_LIMITED',
                balanceFloor ? 409 : 429, error.message)
            }
            throw error
          }
          run.paymentAttempted = true
        }
        let approved: Approval
        try {
          approved = await this.dependencies.approve(run.prepared)
        } finally {
          if (reservation) this.hostedGuard.finishPayment(reservation)
        }
        run.result = approved.result
        if (approved.result.findings.length && this.dependencies.createCapabilitySession) {
          run.capability = this.dependencies.createCapabilitySession(run.prepared, approved.result)
        }
        run.public.state = 'COMPLETE'
        run.public.result = publicResult(approved.result)
        run.public.error = undefined
        this.hostedGuard.releaseRun(run.public.run_id)
        return structuredClone(run.public)
      } catch (error) {
        this.dependencies.logError?.(error instanceof Error ? error.message : 'Unknown hosted demo-agent failure')
        if (error instanceof ExactPaymentDeliveryError) {
          run.approval = undefined
          run.public.state = 'PAYMENT_RECOVERY'
          run.public.error = { code: 'DEMO_PAYMENT_AMBIGUOUS',
            message: 'Payment delivery was ambiguous. Retry recovery with the same signed Hedera transaction.' }
          throw new DemoRunError('DEMO_PAYMENT_AMBIGUOUS', 502, run.public.error.message)
        }
        run.public.state = 'FAILED'
        run.public.error = {
          code: error instanceof DemoRunError ? error.code : 'DEMO_PAYMENT_FAILED',
          message: error instanceof Error ? error.message : 'Hosted demo-agent failed',
        }
        this.hostedGuard.releaseRun(run.public.run_id)
        if (error instanceof DemoRunError) throw error
        throw new DemoRunError('DEMO_PAYMENT_FAILED', 502, 'Hosted demo-agent could not complete payment')
      }
    })()
    return run.approval
  }

  action(runId: string, token: string, action: DemoActionName) {
    const run = this.authorized(runId, token)
    if (run.public.state !== 'COMPLETE' || !run.result) {
      throw new DemoRunError('DEMO_RUN_INCOMPLETE', 409, 'Complete the paid scan before testing authority')
    }
    if (!run.result.findings.length) {
      throw new DemoRunError('DEMO_NO_FINDING', 409, 'This scan is clean; no finding-specific call is available')
    }
    if (!run.capability) {
      throw new DemoRunError('DEMO_ACTION_UNAVAILABLE', 409, 'Capability actions are not configured')
    }
    if ((action === 'replay' || action === 'expire') && !run.public.actions?.legitimate) {
      throw new DemoRunError('DEMO_ACTION_ORDER', 409, 'Run the legitimate call before this action')
    }
    const completed = run.public.actions?.[action]
    if (completed) return Promise.resolve(structuredClone(completed))
    const active = run.actionAttempts.get(action)
    if (active) return active
    const attempt = run.capability.execute(action).then((result) => {
      run.public.actions = { ...run.public.actions, [action]: result }
      if (result.action === 'legitimate' && run.public.result) {
        run.public.result.lease.remaining_calls = result.remaining_calls
      }
      return structuredClone(result)
    }).catch((error: unknown) => {
      run.actionAttempts.delete(action)
      if (error instanceof DemoRunError) throw error
      this.dependencies.logError?.(error instanceof Error ? error.message : 'Unknown capability action failure')
      throw new DemoRunError('DEMO_ACTION_FAILED', 502,
        error instanceof Error ? error.message : 'Hosted demo-agent capability action failed')
    })
    run.actionAttempts.set(action, attempt)
    return attempt
  }
}
