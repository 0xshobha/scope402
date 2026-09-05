import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { decodePaymentRequiredHeader } from '@x402/core/http'
import { PaymentRequiredV2Schema } from '@x402/core/schemas'
import { merchantConfig } from './scans.js'

try {
  const config = merchantConfig()
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const url = new URL('/v1/scans', process.env.AUDITLAB_URL ?? 'http://127.0.0.1:3000')
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      repo_url: 'https://github.com/0xshobha/scope402',
      subject_pubkey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    }),
    signal: AbortSignal.timeout(15_000), redirect: 'error',
  })
  assert.equal(response.status, 402, `Expected 402; received ${response.status}: ${response.status === 402 ? '' : await response.text()}`)
  const header = response.headers.get('PAYMENT-REQUIRED')
  assert.ok(header, 'Missing PAYMENT-REQUIRED')
  const required = PaymentRequiredV2Schema.parse(decodePaymentRequiredHeader(header))
  const body = await response.json() as typeof required & {
    quote: { repository: string; commit_sha: string; pricing: {
      files_considered: number; total_tinybars: string
    } }
  }
  const { quote, ...bodyRequired } = body
  assert.deepEqual(bodyRequired, required)
  assert.equal(required.accepts.length, 1)
  const terms = required.accepts[0]!
  assert.equal(terms.scheme, 'exact')
  assert.equal(terms.network, 'hedera:testnet')
  assert.equal(terms.asset, '0.0.0')
  assert.equal(terms.amount, quote.pricing.total_tinybars)
  assert.equal(terms.payTo, config.payTo)
  assert.equal(typeof terms.extra?.feePayer, 'string')
  assert.ok(terms.extra?.feePayer)
  assert.match(quote.commit_sha, /^[0-9a-f]{40}$/)
  assert.equal(quote.pricing.files_considered >= 0, true)
  console.log('HTTP 402: valid x402 v2 PAYMENT-REQUIRED')
  console.log(`Merchant: ${terms.payTo}`)
  console.log(`Price: ${terms.amount} tinybars`)
  console.log(`Network: ${terms.network}; asset: ${terms.asset}; fee payer: ${terms.extra?.feePayer}`)
  console.log('No payment submitted; no scan executed.')
} catch (error) {
  console.error('402 check failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
}
