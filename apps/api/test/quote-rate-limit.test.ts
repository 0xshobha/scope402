import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QuoteRateLimiter } from '../src/quote-rate-limit.js'

test('limits unpaid quotes per client and resets the window', () => {
  const limiter = new QuoteRateLimiter(2, 60_000)
  assert.equal(limiter.take('203.0.113.1', 1_000).allowed, true)
  assert.equal(limiter.take('203.0.113.1', 1_001).allowed, true)
  assert.deepEqual(limiter.take('203.0.113.1', 1_002), {
    allowed: false, retryAfterSeconds: 60,
  })
  assert.equal(limiter.take('203.0.113.2', 1_002).allowed, true)
  assert.equal(limiter.take('203.0.113.1', 61_000).allowed, true)
})
