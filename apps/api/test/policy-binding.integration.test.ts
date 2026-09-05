import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { encodePaymentSignatureHeader } from '@x402/core/http'
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types'
import { createClientHederaSigner, inspectHederaTransaction, PrivateKey } from '@x402/hedera'
import { ExactHederaScheme } from '@x402/hedera/exact/client'
import { app } from '../src/app.js'
import { canonicalJson } from '../src/canonical.js'
import { closeDatabase, database, initializeDatabase } from '../src/db.js'
import { createQuote, type Pricing } from '../src/payments.js'
import { scope402Extension } from '../src/scope-extension.js'

const repoUrl = 'https://github.com/0xshobha/scope402'
const snapshot = {
  repo: '0xshobha/scope402', commit_sha: 'a'.repeat(40), root_files: ['package.json'],
}
const pricing: Pricing = {
  base_tinybars: '50000', per_file_tinybars: '500', file_cap: 100,
  files_considered: 1, files_charged: 1, total_tinybars: '50500',
}
const requirements: PaymentRequirements = {
  scheme: 'exact', network: 'hedera:testnet', asset: '0.0.0', amount: '50500',
  payTo: '0.0.2002', maxTimeoutSeconds: 120, extra: { feePayer: '0.0.3003' },
}

test('paid HTTP retry enforces the exact persisted Scope402 policy', async (t) => {
  await initializeDatabase()
  t.after(async () => {
    await database().query(
      'DELETE FROM scan_jobs; DELETE FROM tool_leases; DELETE FROM payment_redemptions; DELETE FROM payment_quotes')
    await closeDatabase()
  })

  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const subjectPubkey = publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
  const extensions = scope402Extension(subjectPubkey, snapshot, 'http://127.0.0.1:3000/v1/tools')
  const quote = await createQuote(repoUrl, subjectPubkey, 'http://127.0.0.1:3000/v1/scans',
    requirements, snapshot, pricing, extensions)
  const signer = createClientHederaSigner('0.0.1001', PrivateKey.generateED25519())
  const signed = await new ExactHederaScheme(signer).createPaymentPayload(2, requirements)
  const transactionId = inspectHederaTransaction(signed.payload.transaction as string).transactionId
  const receipt = { success: true, network: 'hedera:testnet', transaction: transactionId, payer: '0.0.1001' }
  await database().query(
    `INSERT INTO payment_redemptions (transaction_id, quote_id, status, payer, receipt)
     VALUES ($1, $2, 'settled', $3, $4)`,
    [transactionId, quote.quoteId, receipt.payer, JSON.stringify(receipt)])
  await database().query(
    `INSERT INTO scan_jobs (transaction_id, quote_id, status, scan_result)
     VALUES ($1, $2, 'complete', $3)`,
    [transactionId, quote.quoteId, JSON.stringify({ status: 'complete', scan_id: randomUUID(),
      repo: snapshot.repo, commit_sha: snapshot.commit_sha, findings: [], payment: {}, lease: {} })])

  const basePayload: PaymentPayload = {
    x402Version: 2, accepted: requirements, resource: { url: quote.resourceUrl },
    payload: signed.payload, extensions,
  }
  const request = (payload: PaymentPayload, quoteId = quote.quoteId) => app.request(
    `/v1/scans?quote_id=${quoteId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json',
        'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(payload) },
      body: JSON.stringify({ repo_url: repoUrl, subject_pubkey: subjectPubkey }),
    })
  const policyInfo = (payload: PaymentPayload) =>
    ((payload.extensions as Record<string, unknown>).scope402 as Record<string, unknown>)
      .info as Record<string, unknown>

  assert.equal((await request(basePayload)).status, 200)

  const missing = structuredClone(basePayload)
  delete missing.extensions
  assert.equal((await request(missing)).status, 400)

  const altered = structuredClone(basePayload)
  const alteredInfo = policyInfo(altered)
  alteredInfo.maxCalls = 4
  assert.equal((await request(altered)).status, 400)

  const recomputed = structuredClone(basePayload)
  const recomputedInfo = policyInfo(recomputed)
  recomputedInfo.maxCalls = 4
  const { policyHash: _, ...changedPolicy } = recomputedInfo
  recomputedInfo.policyHash = `sha256:${createHash('sha256')
    .update(canonicalJson(changedPolicy)).digest('hex')}`
  assert.equal((await request(recomputed)).status, 400)

  const otherQuote = await createQuote(repoUrl, subjectPubkey, 'http://127.0.0.1:3000/v1/scans',
    requirements, snapshot, pricing, extensions)
  assert.equal((await request(basePayload, otherQuote.quoteId)).status, 400)

  await database().query(
    `UPDATE payment_quotes SET scope402_extension = NULL, policy_hash = NULL WHERE quote_id = $1`,
    [quote.quoteId])
  assert.equal((await request(basePayload)).status, 409)
})
