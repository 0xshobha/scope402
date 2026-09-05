import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { PaymentRequirementsV2Schema } from '@x402/core/schemas'
import type { PaymentRequirements } from '@x402/core/types'
import { database, transaction } from './db.js'
import { PaymentError } from './payment-error.js'

function assertQuoteId(quoteId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(quoteId)) {
    throw new PaymentError('QUOTE_INVALID', 'Missing or invalid quote_id')
  }
}

export async function createQuote(repoUrl: string, subjectPubkey: string,
  endpoint: string, requirements: PaymentRequirements) {
  const quoteId = randomUUID()
  const resourceUrl = new URL(endpoint)
  resourceUrl.searchParams.set('quote_id', quoteId)
  await database().query(
    `INSERT INTO payment_quotes
       (quote_id, repo_url, subject_pubkey, resource_url, requirements, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + interval '5 minutes')`,
    [quoteId, repoUrl, subjectPubkey, resourceUrl.href, JSON.stringify(requirements)],
  )
  return { quoteId, resourceUrl: resourceUrl.href }
}

export async function loadQuote(quoteId: string, repoUrl: string, subjectPubkey: string,
  allowExpired = false) {
  assertQuoteId(quoteId)
  const result = await database().query(
    `SELECT resource_url, requirements FROM payment_quotes
     WHERE quote_id = $1 AND repo_url = $2 AND subject_pubkey = $3
       AND ($4::boolean OR expires_at > now())`,
    [quoteId, repoUrl, subjectPubkey, allowExpired],
  )
  if (result.rowCount !== 1) throw new PaymentError('QUOTE_EXPIRED', 'Quote is missing, expired, or bound to another request')
  return {
    resourceUrl: String(result.rows[0].resource_url),
    requirements: PaymentRequirementsV2Schema.parse(result.rows[0].requirements) as PaymentRequirements,
  }
}

export async function settledRedemption(transactionId: string, quoteId: string) {
  assertQuoteId(quoteId)
  const result = await database().query(
    `SELECT quote_id, status, receipt FROM payment_redemptions WHERE transaction_id = $1`,
    [transactionId],
  )
  if (result.rowCount === 0) return undefined
  const row = result.rows[0]
  if (row.quote_id !== quoteId) {
    throw new PaymentError('PAYMENT_REQUIREMENTS_MISMATCH', 'Transaction belongs to another quote')
  }
  if (row.status !== 'settled' || typeof row.receipt !== 'object' || row.receipt === null ||
      row.receipt.success !== true || row.receipt.network !== 'hedera:testnet' ||
      row.receipt.transaction !== transactionId ||
      typeof row.receipt.payer !== 'string' || !/^\d+\.\d+\.[1-9]\d*$/.test(row.receipt.payer)) {
    throw new PaymentError('QUOTE_ALREADY_REDEEMED', 'Transaction cannot be recovered from its current state')
  }
  return row.receipt as { success: true; network: 'hedera:testnet'; transaction: string; payer?: string }
}

export function assertQuotedPayment(payload: { accepted: unknown; resource?: { url: string } },
  quote: Awaited<ReturnType<typeof loadQuote>>) {
  if (!isDeepStrictEqual(payload.accepted, quote.requirements) || payload.resource?.url !== quote.resourceUrl) {
    throw new PaymentError('PAYMENT_REQUIREMENTS_MISMATCH', 'Payment does not match the issued quote')
  }
}

export async function beginRedemption(transactionId: string, quoteId: string) {
  const result = await database().query(
    `INSERT INTO payment_redemptions (transaction_id, quote_id, status)
     VALUES ($1, $2, 'verifying') ON CONFLICT DO NOTHING RETURNING transaction_id`,
    [transactionId, quoteId],
  )
  if (result.rowCount !== 1) throw new PaymentError('QUOTE_ALREADY_REDEEMED', 'Quote or transaction was already used')
}

export async function abandonVerification(transactionId: string) {
  await database().query(`DELETE FROM payment_redemptions WHERE transaction_id = $1 AND status = 'verifying'`, [transactionId])
}

export async function markSettlementAttempted(transactionId: string, payer: string) {
  const result = await database().query(
    `UPDATE payment_redemptions SET status = 'settlement_attempted', payer = $2, updated_at = now()
     WHERE transaction_id = $1 AND status = 'verifying'`, [transactionId, payer])
  if (result.rowCount !== 1) throw new PaymentError('PAYMENT_STATE_ERROR', 'Payment state changed unexpectedly')
}

export async function markSettlement(transactionId: string,
  status: 'settled' | 'settlement_failed' | 'settlement_unknown', receipt: unknown) {
  await transaction(async (client) => {
    const result = await client.query(
      `UPDATE payment_redemptions SET status = $2, receipt = $3, updated_at = now()
       WHERE transaction_id = $1 AND status = 'settlement_attempted'`,
      [transactionId, status, JSON.stringify(receipt ?? null)],
    )
    if (result.rowCount !== 1) throw new PaymentError('PAYMENT_STATE_ERROR', 'Payment state changed unexpectedly')
  })
}
