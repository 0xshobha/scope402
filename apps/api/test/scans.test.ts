import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { test } from 'node:test'
import { decodePaymentRequiredHeader, encodePaymentRequiredHeader } from '@x402/core/http'
import { PaymentRequiredV2Schema } from '@x402/core/schemas'
import { app } from '../src/app.js'
import { clearRepositoryCache } from '../src/github.js'
import { canonicalJson } from '../src/canonical.js'
import { assertScope402Echo, scope402Extension } from '../src/scope-extension.js'
import { assertPaymentAmount, meterScan, parseScanRequest, paymentRequired, pricingConfig,
  scanResourceUrl, settledPaymentDetails } from '../src/scans.js'

const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const request = {
  repo_url: 'https://github.com/0xshobha/scope402',
  subject_pubkey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
}

test('validates a GitHub repository and real P-256 public key', () => {
  assert.deepEqual(parseScanRequest(request), request)
  for (const repo_url of ['https://evil.test/o/r', 'http://github.com/o/r',
    'https://github.com/o/r/tree/main', 'https://user@github.com/o/r']) {
    assert.throws(() => parseScanRequest({ ...request, repo_url }))
  }
  assert.throws(() => parseScanRequest({ ...request, subject_pubkey: 'not-a-key' }))
})

test('encodes a requirement accepted by the official x402 v2 schema', async () => {
  const extensions = scope402Extension(request.subject_pubkey, {
    repo: '0xshobha/scope402', commit_sha: 'a'.repeat(40), root_files: ['package.json'],
  }, 'http://localhost:3000/v1/tools')
  const required = await paymentRequired('http://localhost:3000/v1/scans',
    { payTo: '0.0.12345', amount: '100000' },
    { scheme: 'exact', network: 'hedera:testnet', x402Version: 2, extra: { feePayer: '0.0.67890' } },
    'AuditLab repository scan', extensions)
  const decoded = decodePaymentRequiredHeader(encodePaymentRequiredHeader(required))
  assert.equal(PaymentRequiredV2Schema.safeParse(decoded).success, true)
  assert.deepEqual(decoded, required)
  assert.equal(decoded.accepts[0]?.asset, '0.0.0')
  assert.deepEqual(decoded.extensions, extensions)
})

test('requires the paid payload to echo the exact Scope402 capability policy', () => {
  const extensions = scope402Extension(request.subject_pubkey, {
    repo: '0xshobha/scope402', commit_sha: 'a'.repeat(40), root_files: ['package.json'],
  }, 'http://localhost:3000/v1/tools')
  assert.doesNotThrow(() => assertScope402Echo({ extensions }, extensions))
  const mutations: Array<(changed: typeof extensions) => void> = [
    (changed) => { changed.scope402.info.subject.publicKey = 'attacker' },
    (changed) => { changed.scope402.info.audience = 'https://evil.example/v1/tools' },
    (changed) => { changed.scope402.info.resource.id = 'another/repository' },
    (changed) => { changed.scope402.info.resource.revision = 'b'.repeat(40) },
    (changed) => { (changed.scope402.info.tools as string[]) = ['finding_details', 'delete_repository'] },
    (changed) => { (changed.scope402.info as { maxCalls: number }).maxCalls = 4 },
    (changed) => { (changed.scope402.info as { ttlSeconds: number }).ttlSeconds = 301 },
    (changed) => { changed.scope402.info.policyHash = `sha256:${'0'.repeat(64)}` },
  ]
  for (const mutate of mutations) {
    const changed = structuredClone(extensions)
    mutate(changed)
    assert.throws(() => assertScope402Echo({ extensions: changed }, extensions), /does not echo/)
  }
  const changedWithFreshHash = structuredClone(extensions)
  ;(changedWithFreshHash.scope402.info as { maxCalls: number }).maxCalls = 4
  const { policyHash: _, ...alteredPolicy } = changedWithFreshHash.scope402.info
  changedWithFreshHash.scope402.info.policyHash = `sha256:${createHash('sha256')
    .update(canonicalJson(alteredPolicy)).digest('hex')}`
  assert.throws(() => assertScope402Echo({ extensions: changedWithFreshHash }, extensions), /does not echo/)
  assert.throws(() => assertScope402Echo({}, extensions), /does not echo/)
})

test('rejects invalid scan requests before discovery', async () => {
  const response = await app.request('/v1/scans', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })
  assert.equal(response.status, 400)
  assert.equal(response.headers.has('PAYMENT-REQUIRED'), false)
})

test('never treats an arbitrary payment header as a paid scan', async () => {
  const response = await app.request('/v1/scans', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'PAYMENT-SIGNATURE': 'invalid' },
    body: JSON.stringify(request),
  })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error, 'PAYMENT_INVALID')
})

test('refuses to advertise payment without merchant configuration', async (t) => {
  const previous = process.env.HEDERA_MERCHANT_ACCOUNT_ID
  delete process.env.HEDERA_MERCHANT_ACCOUNT_ID
  t.after(() => {
    if (previous === undefined) delete process.env.HEDERA_MERCHANT_ACCOUNT_ID
    else process.env.HEDERA_MERCHANT_ACCOUNT_ID = previous
  })
  const response = await app.request('/v1/scans', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
  assert.equal(response.status, 503)
  assert.equal((await response.json()).error, 'PAYMENT_NOT_CONFIGURED')
  assert.equal(response.headers.has('PAYMENT-REQUIRED'), false)
})

test('reports a missing or private GitHub repository as a client error', async (t) => {
  const merchant = process.env.HEDERA_MERCHANT_ACCOUNT_ID
  const originalFetch = globalThis.fetch
  process.env.HEDERA_MERCHANT_ACCOUNT_ID = '0.0.12345'
  clearRepositoryCache()
  globalThis.fetch = (async () => new Response('{}', { status: 404 })) as typeof fetch
  t.after(() => {
    if (merchant === undefined) delete process.env.HEDERA_MERCHANT_ACCOUNT_ID
    else process.env.HEDERA_MERCHANT_ACCOUNT_ID = merchant
    globalThis.fetch = originalFetch
    clearRepositoryCache()
  })
  const response = await app.request('/v1/scans', {
    method: 'POST', headers: { 'Content-Type': 'application/json',
      'X-Forwarded-For': '203.0.113.44' }, body: JSON.stringify(request),
  })
  assert.equal(response.status, 404)
  assert.equal((await response.json()).error, 'REPOSITORY_NOT_FOUND')
})

test('rejects invalid metered tinybar amounts', (t) => {
  const merchant = process.env.HEDERA_MERCHANT_ACCOUNT_ID
  t.after(() => {
    if (merchant === undefined) delete process.env.HEDERA_MERCHANT_ACCOUNT_ID
    else process.env.HEDERA_MERCHANT_ACCOUNT_ID = merchant
  })
  process.env.HEDERA_MERCHANT_ACCOUNT_ID = '0.0.12345'
  for (const amount of ['0', '-1', '0.001', '1e5', '100000001', 'abc']) {
    assert.throws(() => assertPaymentAmount(amount), /Metered scan amount/)
  }
})

test('meters bounded repository workload deterministically', () => {
  const config = { base: 50_000n, perFile: 500n, cap: 100 }
  assert.equal(meterScan(0, config).total_tinybars, '50000')
  assert.equal(meterScan(1, config).total_tinybars, '50500')
  assert.equal(meterScan(20, config).total_tinybars, '60000')
  assert.deepEqual(meterScan(101, config), {
    base_tinybars: '50000', per_file_tinybars: '500', file_cap: 100,
    files_considered: 101, files_charged: 100, total_tinybars: '100000',
  })
  assert.throws(() => meterScan(-1, config), /non-negative integer/)
})

test('validates metering policy configuration', (t) => {
  const names = ['SCAN_BASE_PRICE_TINYBARS', 'SCAN_PER_FILE_TINYBARS', 'SCAN_FILE_CAP'] as const
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  t.after(() => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name]
      else process.env[name] = previous[name]
    }
  })
  process.env.SCAN_BASE_PRICE_TINYBARS = '50000'
  process.env.SCAN_PER_FILE_TINYBARS = '500'
  process.env.SCAN_FILE_CAP = '100'
  assert.deepEqual(pricingConfig(), { base: 50_000n, perFile: 500n, cap: 100 })
  process.env.SCAN_FILE_CAP = '1001'
  assert.throws(pricingConfig, /SCAN_FILE_CAP/)
  process.env.SCAN_FILE_CAP = '100'
  process.env.SCAN_PER_FILE_TINYBARS = '1000000'
  assert.throws(pricingConfig, /must not exceed 1 HBAR/)
})

test('reports settled quote terms instead of current merchant configuration', () => {
  const details = settledPaymentDetails({
    scheme: 'exact', network: 'hedera:testnet', asset: '0.0.0',
    amount: '70000', payTo: '0.0.11111', maxTimeoutSeconds: 120, extra: { feePayer: '0.0.67890' },
  }, { payer: '0.0.22222', transaction: '0.0.67890@1700000000.123456789' })
  assert.equal(details.merchant, '0.0.11111')
  assert.equal(details.amount_tinybars, '70000')
})

test('uses the configured public origin behind a TLS proxy', (t) => {
  const previous = process.env.AUDITLAB_URL
  process.env.AUDITLAB_URL = 'https://scope402-auditlab.onrender.com'
  t.after(() => {
    if (previous === undefined) delete process.env.AUDITLAB_URL
    else process.env.AUDITLAB_URL = previous
  })
  assert.equal(scanResourceUrl('http://scope402-auditlab.onrender.com/v1/scans'),
    'https://scope402-auditlab.onrender.com/v1/scans')
})
