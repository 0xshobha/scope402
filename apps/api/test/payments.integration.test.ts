import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PaymentRequirements } from '@x402/core/types'
import { closeDatabase, database, initializeDatabase } from '../src/db.js'
import { abandonVerification, beginRedemption, createQuote, loadQuote,
  markSettlement, markSettlementAttempted, type Pricing } from '../src/payments.js'
import { scope402Extension, scope402PolicyHash, type Scope402Policy } from '../src/scope-extension.js'
import { reconcileAmbiguousRedemption } from '../src/settlement.js'

const requirements: PaymentRequirements = {
  scheme: 'exact', network: 'hedera:testnet', asset: '0.0.0', amount: '50500',
  payTo: '0.0.8258555', maxTimeoutSeconds: 120, extra: { feePayer: '0.0.7162784' },
}
const snapshot = {
  repo: '0xshobha/scope402', commit_sha: 'a'.repeat(40), root_files: ['package.json'],
}
const pricing: Pricing = {
  base_tinybars: '50000', per_file_tinybars: '500', file_cap: 100,
  files_considered: 1, files_charged: 1, total_tinybars: '50500',
}

test('persists bound quotes and redemption state', async (t) => {
  await initializeDatabase()
  t.after(async () => {
    await database().query('DELETE FROM payment_redemptions; DELETE FROM payment_quotes')
    await closeDatabase()
  })
  const quote = await createQuote('https://github.com/0xshobha/scope402', 'subject',
    'http://127.0.0.1:3000/v1/scans', requirements, snapshot, pricing,
    scope402Extension('subject', snapshot, 'http://127.0.0.1:3000/v1/tools'))
  const stored = await loadQuote(quote.quoteId, 'https://github.com/0xshobha/scope402', 'subject')
  assert.equal(stored.resourceUrl, quote.resourceUrl)
  assert.deepEqual(stored.requirements, requirements)
  assert.deepEqual(stored.snapshot, snapshot)
  assert.deepEqual(stored.pricing, pricing)
  assert.equal(stored.policyHash, stored.scope402Extension?.scope402.info.policyHash)
  assert.equal(stored.scope402Extension?.scope402.info.subject.publicKey, 'subject')
  assert.equal(stored.scope402Extension?.scope402.info.resource.revision, snapshot.commit_sha)
  await assert.rejects(loadQuote(quote.quoteId, 'https://github.com/another/repo', 'subject'), /bound/)

  await database().query(`UPDATE payment_quotes SET policy_hash = $2 WHERE quote_id = $1`,
    [quote.quoteId, `sha256:${'0'.repeat(64)}`])
  await assert.rejects(loadQuote(quote.quoteId, 'https://github.com/0xshobha/scope402', 'subject'),
    /policy does not match/)
  await database().query(`UPDATE payment_quotes SET policy_hash = $2 WHERE quote_id = $1`,
    [quote.quoteId, stored.policyHash])

  const changedAudience = structuredClone(stored.scope402Extension!)
  changedAudience.scope402.info.audience = 'https://evil.example/v1/tools'
  const { policyHash: _, ...changedPolicy } = changedAudience.scope402.info
  changedAudience.scope402.info.policyHash = scope402PolicyHash(changedPolicy as Scope402Policy)
  await database().query(
    `UPDATE payment_quotes SET scope402_extension = $2, policy_hash = $3 WHERE quote_id = $1`,
    [quote.quoteId, JSON.stringify(changedAudience), changedAudience.scope402.info.policyHash])
  await assert.rejects(loadQuote(quote.quoteId, 'https://github.com/0xshobha/scope402', 'subject'),
    /policy does not match/)
  await database().query(
    `UPDATE payment_quotes SET scope402_extension = $2, policy_hash = $3 WHERE quote_id = $1`,
    [quote.quoteId, JSON.stringify(stored.scope402Extension), stored.policyHash])

  const tx = '0.0.7162784@1700000000.123456789'
  await beginRedemption(tx, quote.quoteId)
  await assert.rejects(beginRedemption(tx, quote.quoteId), /already used/)
  await markSettlementAttempted(tx, '0.0.8258066')
  await markSettlement(tx, 'settled', { success: true, transaction: tx })
  const row = await database().query(
    'SELECT status, payer, receipt FROM payment_redemptions WHERE transaction_id = $1', [tx])
  assert.deepEqual(row.rows[0], {
    status: 'settled', payer: '0.0.8258066', receipt: { success: true, transaction: tx },
  })
  await abandonVerification(tx)
  assert.equal((await database().query(
    'SELECT status FROM payment_redemptions WHERE transaction_id = $1', [tx])).rows[0].status, 'settled')
})

test('recovers a persisted ambiguous settlement from Hedera without settling again', async (t) => {
  await initializeDatabase()
  const originalFetch = globalThis.fetch
  t.after(async () => {
    globalThis.fetch = originalFetch
    await database().query('DELETE FROM payment_redemptions; DELETE FROM payment_quotes')
    await closeDatabase()
  })
  const quote = await createQuote('https://github.com/0xshobha/scope402', 'subject',
    'http://127.0.0.1:3000/v1/scans', requirements, snapshot, pricing,
    scope402Extension('subject', snapshot, 'http://127.0.0.1:3000/v1/tools'))
  const tx = '0.0.7162784@1700000000.123456789'
  const payer = '0.0.8258066'
  await beginRedemption(tx, quote.quoteId)
  await markSettlementAttempted(tx, payer)
  await markSettlement(tx, 'settlement_unknown', { error: 'facilitator response lost' })
  let mirrorCalls = 0
  globalThis.fetch = (async (input) => {
    mirrorCalls += 1
    assert.match(String(input), /mirrornode\.hedera\.com\/api\/v1\/transactions\//)
    return new Response(JSON.stringify({ transactions: [{
      transaction_id: '0.0.7162784-1700000000-123456789', result: 'SUCCESS',
      name: 'CRYPTOTRANSFER', transfers: [
        { account: payer, amount: -50500 }, { account: requirements.payTo, amount: 50500 },
      ],
    }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  assert.deepEqual(await reconcileAmbiguousRedemption(tx, quote.quoteId), {
    success: true, network: 'hedera:testnet', transaction: tx, payer,
  })
  assert.equal(mirrorCalls, 1)
  const stored = await database().query(
    'SELECT status, receipt FROM payment_redemptions WHERE transaction_id = $1', [tx])
  assert.equal(stored.rows[0].status, 'settled')
  assert.equal(stored.rows[0].receipt.transaction, tx)
})
