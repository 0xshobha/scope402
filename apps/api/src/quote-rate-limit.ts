type Bucket = { count: number; resetsAt: number }

export class QuoteRateLimiter {
  private readonly buckets = new Map<string, Bucket>()

  constructor(private readonly limit = 10, private readonly windowMs = 60_000) {}

  take(identity: string, now = Date.now()) {
    const key = identity.trim() || 'unknown'
    const current = this.buckets.get(key)
    if (!current || current.resetsAt <= now) {
      if (!current && this.buckets.size >= 2_048) {
        for (const [candidate, bucket] of this.buckets) {
          if (bucket.resetsAt <= now) this.buckets.delete(candidate)
        }
        if (this.buckets.size >= 2_048) this.buckets.delete(this.buckets.keys().next().value!)
      }
      this.buckets.set(key, { count: 1, resetsAt: now + this.windowMs })
      return { allowed: true, retryAfterSeconds: 0 }
    }
    if (current.count >= this.limit) {
      return { allowed: false, retryAfterSeconds: Math.max(1,
        Math.ceil((current.resetsAt - now) / 1_000)) }
    }
    current.count += 1
    return { allowed: true, retryAfterSeconds: 0 }
  }
}

export const quoteRateLimiter = new QuoteRateLimiter()
