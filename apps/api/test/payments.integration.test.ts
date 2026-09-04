import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PaymentRequirements } from '@x402/core/types'
import { closeDatabase, database, initializeDatabase } from '../src/db.js'
import { abandonVerification, beginRedemption, createQuote, loadQuote,
  markSettlement, markSettlementAttempted } from '../src/payments.js'

const requirements: PaymentRequirements = {
  scheme: 'exact', network: 'hedera:testnet', asset: '0.0.0', amount: '100000',
  payTo: '0.0.8258555', maxTimeoutSeconds: 120, extra: { feePayer: '0.0.7162784' },
}

test('persists bound quotes and redemption state', async (t) => {
  await initializeDatabase()
  t.after(async () => {
    await database().query('DELETE FROM payment_redemptions; DELETE FROM payment_quotes')
    await closeDatabase()
  })
  const quote = await createQuote('https://github.com/0xshobha/scope402', 'subject',
    'http://127.0.0.1:3000/v1/scans', requirements)
  const stored = await loadQuote(quote.quoteId, 'https://github.com/0xshobha/scope402', 'subject')
  assert.equal(stored.resourceUrl, quote.resourceUrl)
  assert.deepEqual(stored.requirements, requirements)
  await assert.rejects(loadQuote(quote.quoteId, 'https://github.com/another/repo', 'subject'), /bound/)

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
