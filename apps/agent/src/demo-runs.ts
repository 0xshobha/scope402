import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { PreparedScan, ScanResult } from './purchase.js'

export type DemoState = 'PAYMENT_REQUIRED' | 'SETTLING' | 'COMPLETE' | 'FAILED'

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
  error?: { code: string; message: string }
}

type InternalRun = {
  public: PublicRun
  ip: string
  tokenHash: Buffer
  prepared: PreparedScan
  approval?: Promise<PublicRun>
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
  private readonly runAttempts = new Map<string, number[]>()
  private readonly globalRuns: number[] = []
  private readonly approvals: Array<{ at: number; amount: bigint }> = []

  constructor(private readonly dependencies: DemoRunDependencies,
    private readonly limits: DemoRunLimits) {}

  private now() {
    return this.dependencies.now?.() ?? Date.now()
  }

  private trim(now: number) {
    for (const [ip, values] of this.runAttempts) {
      const current = values.filter((value) => value > now - hourMs)
      if (current.length) this.runAttempts.set(ip, current)
      else this.runAttempts.delete(ip)
    }
    while (this.approvals[0] && this.approvals[0].at <= now - hourMs) this.approvals.shift()
    while (this.globalRuns[0] && this.globalRuns[0] <= now - hourMs) this.globalRuns.shift()
    for (const [id, run] of this.runs) {
      if (Date.parse(run.public.expires_at) + hourMs < now) this.runs.delete(id)
    }
  }

  async create(repoUrl: string, ip: string) {
    const now = this.now()
    this.trim(now)
    const attempts = this.runAttempts.get(ip) ?? []
    if (attempts.length >= this.limits.perIpRunsPerHour ||
        this.globalRuns.length >= this.limits.globalRunsPerHour) {
      throw new DemoRunError('DEMO_RATE_LIMITED', 429, 'Too many demo runs from this address')
    }
    const active = [...this.runs.values()].some((run) => run.ip === ip &&
      !['COMPLETE', 'FAILED'].includes(run.public.state) && Date.parse(run.public.expires_at) > now)
    if (active) throw new DemoRunError('DEMO_RUN_ACTIVE', 409, 'This visitor already has an active demo run')
    attempts.push(now)
    this.globalRuns.push(now)
    this.runAttempts.set(ip, attempts)
    const prepared = await this.dependencies.prepare(repoUrl)
    const runId = randomUUID()
    const token = randomBytes(32).toString('base64url')
    const publicRun: PublicRun = {
      run_id: runId,
      state: 'PAYMENT_REQUIRED',
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + this.limits.runTtlMs).toISOString(),
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
      tokenHash: createHash('sha256').update(token).digest(), prepared })
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
    const now = this.now()
    this.trim(now)
    if (this.approvals.length >= this.limits.globalApprovalsPerHour ||
        this.approvals.reduce((total, item) => total + item.amount, 0n) + amount >
          this.limits.maxHourlySpendTinybars) {
      throw new DemoRunError('DEMO_SPEND_LIMITED', 429, 'Hosted demo-agent spend limit reached')
    }
    this.approvals.push({ at: now, amount })
    run.public.state = 'SETTLING'
    run.approval = (async () => {
      try {
        const balance = await this.dependencies.payerBalanceTinybars()
        if (balance - amount < this.limits.minimumBalanceTinybars) {
          throw new DemoRunError('DEMO_BALANCE_FLOOR', 409, 'Hosted demo-agent balance floor reached')
        }
        const approved = await this.dependencies.approve(run.prepared)
        run.public.state = 'COMPLETE'
        run.public.result = publicResult(approved.result)
        return structuredClone(run.public)
      } catch (error) {
        this.dependencies.logError?.(error instanceof Error ? error.message : 'Unknown hosted demo-agent failure')
        run.public.state = 'FAILED'
        run.public.error = {
          code: error instanceof DemoRunError ? error.code : 'DEMO_PAYMENT_FAILED',
          message: error instanceof Error ? error.message : 'Hosted demo-agent failed',
        }
        if (error instanceof DemoRunError) throw error
        throw new DemoRunError('DEMO_PAYMENT_FAILED', 502, 'Hosted demo-agent could not complete payment')
      }
    })()
    return run.approval
  }
}
