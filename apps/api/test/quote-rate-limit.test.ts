import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QuoteRateLimiter } from '../src/quote-rate-limit.js'
import { quoteClientIdentity, trustedProxy } from '../src/client-ip.js'

test('ignores caller-supplied forwarding identities without a trusted proxy', () => {
  assert.equal(quoteClientIdentity({ cloudflare: '203.0.113.1', forwarded: '198.51.100.1',
    real: '192.0.2.1' }, 'none'), 'unknown')
})

test('uses only a valid Cloudflare identity on Render', () => {
  assert.equal(quoteClientIdentity({ cloudflare: '203.0.113.1' }, 'render'), '203.0.113.1')
  assert.equal(quoteClientIdentity({ cloudflare: '2001:db8::1' }, 'render'), '2001:db8::1')
  assert.equal(quoteClientIdentity({ cloudflare: '203.0.113.1, 198.51.100.1' }, 'render'), 'unknown')
  assert.equal(quoteClientIdentity({ cloudflare: 'attacker' }, 'render'), 'unknown')
  assert.equal(quoteClientIdentity({ cloudflare: '203.0.113.1', forwarded: '198.51.100.1',
    real: '192.0.2.1' }, 'render'), quoteClientIdentity({ cloudflare: '203.0.113.1',
    forwarded: '198.51.100.99', real: '192.0.2.99' }, 'render'))
})

test('fails closed for an unsupported trusted proxy configuration', () => {
  assert.throws(() => trustedProxy('cloudflare'),
    /AUDITLAB_TRUSTED_PROXY must be none or render/)
})

test('selects Render trust only inside an explicit Render environment', (t) => {
  const previousRender = process.env.RENDER
  const previousProxy = process.env.AUDITLAB_TRUSTED_PROXY
  t.after(() => {
    if (previousRender === undefined) delete process.env.RENDER
    else process.env.RENDER = previousRender
    if (previousProxy === undefined) delete process.env.AUDITLAB_TRUSTED_PROXY
    else process.env.AUDITLAB_TRUSTED_PROXY = previousProxy
  })
  delete process.env.AUDITLAB_TRUSTED_PROXY
  delete process.env.RENDER
  assert.equal(trustedProxy(), 'none')
  process.env.RENDER = 'true'
  assert.equal(trustedProxy(), 'render')
  process.env.AUDITLAB_TRUSTED_PROXY = 'none'
  assert.equal(trustedProxy(), 'none')
})

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
