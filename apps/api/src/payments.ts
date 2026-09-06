import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { PaymentRequirementsV2Schema } from '@x402/core/schemas'
import type { PaymentRequirements } from '@x402/core/types'
import type { RepositorySnapshot } from './github.js'
import { database, transaction, type TransactionClient } from './db.js'
import { PaymentError } from './payment-error.js'
import { parseScope402Extension, type Scope402Extensions } from './scope-extension.js'

export function assertQuoteId(quoteId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(quoteId)) {
    throw new PaymentError('QUOTE_INVALID', 'Missing or invalid quote_id')
  }
}

export async function createQuote(repoUrl: string, subjectPubkey: string,
  endpoint: string, requirements: PaymentRequirements, snapshot: RepositorySnapshot,
  pricing: Pricing, extensions: Scope402Extensions) {
  if (pricing.files_considered !== snapshot.root_files.length ||
      pricing.total_tinybars !== requirements.amount) {
    throw new PaymentError('PAYMENT_STATE_ERROR', 'Quote snapshot, pricing, and payment amount disagree')
  }
  const storedExtensions = parseScope402Extension(extensions)
  const policy = storedExtensions.scope402.info
  const expectedAudience = new URL('/v1/tools', endpoint).href
  if (policy.subject.publicKey !== subjectPubkey || policy.resource.id !== snapshot.repo ||
      policy.resource.revision !== snapshot.commit_sha || policy.audience !== expectedAudience) {
    throw new PaymentError('PAYMENT_STATE_ERROR', 'Scope402 policy does not match quote inputs')
  }
  const quoteId = randomUUID()
  const resourceUrl = new URL(endpoint)
  resourceUrl.searchParams.set('quote_id', quoteId)
  await database().query(
    `INSERT INTO payment_quotes
       (quote_id, repo_url, subject_pubkey, resource_url, requirements, expires_at,
        repository_name, commit_sha, root_files, files_considered, pricing,
        scope402_extension, policy_hash)
     VALUES ($1, $2, $3, $4, $5, now() + interval '5 minutes', $6, $7, $8, $9, $10, $11, $12)`,
    [quoteId, repoUrl, subjectPubkey, resourceUrl.href, JSON.stringify(requirements),
      snapshot.repo, snapshot.commit_sha, JSON.stringify(snapshot.root_files),
      snapshot.root_files.length, JSON.stringify(pricing), JSON.stringify(storedExtensions), policy.policyHash],
  )
  return { quoteId, resourceUrl: resourceUrl.href }
}

export async function loadQuote(quoteId: string, repoUrl: string, subjectPubkey: string,
  allowExpired = false) {
  assertQuoteId(quoteId)
  const result = await database().query(
    `SELECT resource_url, requirements, repository_name, commit_sha, root_files,
            files_considered, pricing, scope402_extension, policy_hash
     FROM payment_quotes
     WHERE quote_id = $1 AND repo_url = $2 AND subject_pubkey = $3
       AND ($4::boolean OR expires_at > now())`,
    [quoteId, repoUrl, subjectPubkey, allowExpired],
  )
  if (result.rowCount !== 1) throw new PaymentError('QUOTE_EXPIRED', 'Quote is missing, expired, or bound to another request')
  const row = result.rows[0]
  const legacyQuote = row.repository_name === null && row.commit_sha === null &&
    row.root_files === null && row.files_considered === null && row.pricing === null
  const rootFilesValid = Array.isArray(row.root_files) &&
    row.root_files.every((name: unknown) => typeof name === 'string')
  const snapshot = typeof row.repository_name === 'string' &&
    /^[0-9a-f]{40}$/.test(String(row.commit_sha)) && rootFilesValid &&
    row.files_considered === row.root_files.length ? {
      repo: row.repository_name as string,
      commit_sha: row.commit_sha as string,
      root_files: row.root_files as string[],
    } : undefined
  const pricing = parsePricing(row.pricing, row.files_considered)
  const storedExtension = row.scope402_extension === null ? undefined : parseScope402Extension(row.scope402_extension)
  const expectedAudience = new URL('/v1/tools', String(row.resource_url)).href
  if (storedExtension && (row.policy_hash !== storedExtension.scope402.info.policyHash ||
      storedExtension.scope402.info.subject.publicKey !== subjectPubkey ||
      storedExtension.scope402.info.resource.id !== row.repository_name ||
      storedExtension.scope402.info.resource.revision !== row.commit_sha ||
      storedExtension.scope402.info.audience !== expectedAudience)) {
    throw new PaymentError('PAYMENT_STATE_ERROR', 'Stored Scope402 policy does not match quote state')
  }
  if (!legacyQuote && (!snapshot || !pricing || pricing.total_tinybars !== row.requirements.amount)) {
    throw new PaymentError('PAYMENT_STATE_ERROR', 'Stored quote snapshot or pricing is invalid')
  }
  return {
    resourceUrl: String(row.resource_url),
    requirements: PaymentRequirementsV2Schema.parse(row.requirements) as PaymentRequirements,
    snapshot,
    pricing,
    scope402Extension: storedExtension,
    policyHash: storedExtension?.scope402.info.policyHash,
  }
}

export type Pricing = {
  base_tinybars: string
  per_file_tinybars: string
  file_cap: number
  files_considered: number
  files_charged: number
  total_tinybars: string
}

function parsePricing(value: unknown, filesConsidered: unknown): Pricing | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const pricing = value as Record<string, unknown>
  if (typeof pricing.base_tinybars !== 'string' || !/^[1-9]\d*$/.test(pricing.base_tinybars) ||
      typeof pricing.per_file_tinybars !== 'string' || !/^[1-9]\d*$/.test(pricing.per_file_tinybars) ||
      !Number.isSafeInteger(pricing.file_cap) || Number(pricing.file_cap) < 1 ||
      !Number.isSafeInteger(pricing.files_considered) || pricing.files_considered !== filesConsidered ||
      !Number.isSafeInteger(pricing.files_charged) || Number(pricing.files_charged) < 0 ||
      Number(pricing.files_charged) > Number(pricing.file_cap) ||
      typeof pricing.total_tinybars !== 'string' || !/^[1-9]\d*$/.test(pricing.total_tinybars)) {
    return undefined
  }
  return pricing as Pricing
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

export async function ambiguousRedemption(transactionId: string, quoteId: string) {
  assertQuoteId(quoteId)
  const result = await database().query(
    `SELECT redemption.quote_id, redemption.status, redemption.payer, quote.requirements
     FROM payment_redemptions AS redemption
     JOIN payment_quotes AS quote ON quote.quote_id = redemption.quote_id
     WHERE redemption.transaction_id = $1`,
    [transactionId],
  )
  if (result.rowCount === 0) return undefined
  const row = result.rows[0]
  if (row.quote_id !== quoteId) {
    throw new PaymentError('PAYMENT_REQUIREMENTS_MISMATCH', 'Transaction belongs to another quote')
  }
  if (!['settlement_attempted', 'settlement_unknown'].includes(String(row.status))) return undefined
  if (typeof row.payer !== 'string' || !/^\d+\.\d+\.[1-9]\d*$/.test(row.payer)) {
    throw new PaymentError('PAYMENT_STATE_ERROR', 'Ambiguous settlement has no valid payer')
  }
  return { payer: row.payer as string,
    requirements: PaymentRequirementsV2Schema.parse(row.requirements) as PaymentRequirements }
}

export function assertQuotedPayment(payload: { accepted: unknown; resource?: { url: string } },
  quote: { requirements: PaymentRequirements; resourceUrl: string }) {
  if (!isDeepStrictEqual(payload.accepted, quote.requirements) || payload.resource?.url !== quote.resourceUrl) {
    throw new PaymentError('PAYMENT_REQUIREMENTS_MISMATCH', 'Payment does not match the issued quote')
  }
}

async function insertRedemption(query: (text: string, values: string[]) =>
  Promise<{ rowCount: number | null }>,
  transactionId: string, quoteId: string) {
  const result = await query(
    `INSERT INTO payment_redemptions (transaction_id, quote_id, status)
     VALUES ($1, $2, 'verifying') ON CONFLICT DO NOTHING RETURNING transaction_id`,
    [transactionId, quoteId],
  )
  if (result.rowCount !== 1) throw new PaymentError('QUOTE_ALREADY_REDEEMED', 'Quote or transaction was already used')
}

export async function beginRedemption(transactionId: string, quoteId: string) {
  return insertRedemption((text, values) => database().query(text, values), transactionId, quoteId)
}

export async function beginRedemptionInTransaction(client: TransactionClient,
  transactionId: string, quoteId: string) {
  return insertRedemption((text, values) => client.query(text, values), transactionId, quoteId)
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

export async function markReconciledSettlement(transactionId: string, receipt: unknown) {
  const result = await database().query(
    `UPDATE payment_redemptions SET status = 'settled', receipt = $2, updated_at = now()
     WHERE transaction_id = $1 AND status IN ('settlement_attempted', 'settlement_unknown')`,
    [transactionId, JSON.stringify(receipt ?? null)],
  )
  if (result.rowCount !== 1) {
    const recovered = await database().query(
      `SELECT status FROM payment_redemptions WHERE transaction_id = $1`, [transactionId])
    if (recovered.rowCount !== 1 || recovered.rows[0].status !== 'settled') {
      throw new PaymentError('PAYMENT_STATE_ERROR', 'Payment state changed during reconciliation')
    }
  }
}
