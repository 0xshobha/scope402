import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { test } from 'node:test'
import { decodePaymentRequiredHeader, encodePaymentRequiredHeader } from '@x402/core/http'
import { PaymentRequiredV2Schema } from '@x402/core/schemas'
import { app } from '../src/app.js'
import { parseScanRequest, paymentConfig, paymentRequired } from '../src/scans.js'

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
  const required = await paymentRequired('http://localhost:3000/v1/scans',
    { payTo: '0.0.12345', amount: '100000' },
    { scheme: 'exact', network: 'hedera:testnet', x402Version: 2, extra: { feePayer: '0.0.67890' } })
  const decoded = decodePaymentRequiredHeader(encodePaymentRequiredHeader(required))
  assert.equal(PaymentRequiredV2Schema.safeParse(decoded).success, true)
  assert.deepEqual(decoded, required)
  assert.equal(decoded.accepts[0]?.asset, '0.0.0')
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

test('rejects invalid tinybar prices', (t) => {
  const merchant = process.env.HEDERA_MERCHANT_ACCOUNT_ID
  const price = process.env.SCAN_PRICE_TINYBARS
  t.after(() => {
    if (merchant === undefined) delete process.env.HEDERA_MERCHANT_ACCOUNT_ID
    else process.env.HEDERA_MERCHANT_ACCOUNT_ID = merchant
    if (price === undefined) delete process.env.SCAN_PRICE_TINYBARS
    else process.env.SCAN_PRICE_TINYBARS = price
  })
  process.env.HEDERA_MERCHANT_ACCOUNT_ID = '0.0.12345'
  for (const amount of ['0', '-1', '0.001', '1e5', '100000001', 'abc']) {
    process.env.SCAN_PRICE_TINYBARS = amount
    assert.throws(paymentConfig, /SCAN_PRICE_TINYBARS/)
  }
})
