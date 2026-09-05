import { randomUUID } from 'node:crypto'

export class HostedAgentLimitError extends Error {}

type Approval = { at: number; amount: bigint }

export class HostedAgentGuard {
  private readonly approvals: Approval[] = []
  private readonly pending = new Map<string, { payer: string; amount: bigint }>()
  private readonly runAttempts = new Map<string, number[]>()
  private readonly globalRuns: number[] = []
  private readonly activeRuns = new Map<string, { runId: string; expiresAt: number }>()

  constructor(private readonly limits: {
    perIpRunsPerHour: number
    globalRunsPerHour: number
    globalApprovalsPerHour: number
    maxHourlySpendTinybars: bigint
  }, private readonly now: () => number = Date.now) {}

  private trim(now: number) {
    while (this.approvals[0] && this.approvals[0].at <= now - 60 * 60 * 1_000) {
      this.approvals.shift()
    }
    while (this.globalRuns[0] && this.globalRuns[0] <= now - 60 * 60 * 1_000) {
      this.globalRuns.shift()
    }
    for (const [ip, values] of this.runAttempts) {
      const current = values.filter((value) => value > now - 60 * 60 * 1_000)
      if (current.length) this.runAttempts.set(ip, current)
      else this.runAttempts.delete(ip)
    }
    for (const [ip, active] of this.activeRuns) {
      if (active.expiresAt <= now) this.activeRuns.delete(ip)
    }
  }

  acquireRun(ip: string, runId: string, expiresAt: number) {
    const now = this.now()
    this.trim(now)
    const attempts = this.runAttempts.get(ip) ?? []
    if (attempts.length >= this.limits.perIpRunsPerHour ||
        this.globalRuns.length >= this.limits.globalRunsPerHour) {
      throw new HostedAgentLimitError('Too many hosted-agent runs from this address')
    }
    if (this.activeRuns.has(ip)) {
      throw new HostedAgentLimitError('This visitor already has an active hosted-agent run')
    }
    attempts.push(now)
    this.globalRuns.push(now)
    this.runAttempts.set(ip, attempts)
    this.activeRuns.set(ip, { runId, expiresAt })
  }

  releaseRun(runId: string) {
    for (const [ip, active] of this.activeRuns) {
      if (active.runId === runId) this.activeRuns.delete(ip)
    }
  }

  assertPaymentCapacity(amount: bigint) {
    const now = this.now()
    this.trim(now)
    if (this.approvals.length >= this.limits.globalApprovalsPerHour ||
        this.approvals.reduce((total, item) => total + item.amount, 0n) + amount >
          this.limits.maxHourlySpendTinybars) {
      throw new HostedAgentLimitError('Hosted agent spend limit reached')
    }
  }

  reservePayment(payer: string, amount: bigint, balance: bigint, minimumBalance: bigint) {
    const now = this.now()
    this.assertPaymentCapacity(amount)
    const outstanding = [...this.pending.values()]
      .filter((reservation) => reservation.payer === payer)
      .reduce((total, reservation) => total + reservation.amount, 0n)
    if (balance - outstanding - amount < minimumBalance) {
      throw new HostedAgentLimitError('Hosted agent balance floor reached')
    }
    const id = randomUUID()
    this.approvals.push({ at: now, amount })
    this.pending.set(id, { payer, amount })
    return id
  }

  finishPayment(reservationId: string) {
    this.pending.delete(reservationId)
  }
}
