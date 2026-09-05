import type { PaymentRequirements, SettleResponse } from '@x402/core/types'
import { isDeepStrictEqual } from 'node:util'
import { database, transaction } from '../../db.js'
import { settledPaymentDetails } from '../../payment-receipt.js'
import { parseTesseraScope402Extension } from '../../scope-extension.js'
import { persistRootCapability, prepareRootCapability } from '../../scope402/issuance.js'
import type { TesseraScope402PolicyInfo } from '../../scope-extension.js'
import { exactPolicyEcho } from '../../scope402/policy.js'
import { TESSERA_MERCHANT_ID } from './quotes.js'

export class PlotJobError extends Error {
  constructor(public readonly code:
    'PLOT_IN_PROGRESS' | 'PLOT_RETRYABLE' | 'PLOT_RESERVATION_LOST', message: string) {
    super(message)
  }
}

type CompletedPlot = {
  status: 'complete'
  canvas_id: string
  region: TesseraScope402PolicyInfo['resource']
  payment: ReturnType<typeof settledPaymentDetails>
  lease: { token: string } & Awaited<ReturnType<typeof prepareRootCapability>>['claims']
}

async function ensureJob(transactionId: string, quoteId: string) {
  await database().query(
    `INSERT INTO plot_jobs (transaction_id, quote_id, status)
     VALUES ($1, $2, 'pending') ON CONFLICT DO NOTHING`,
    [transactionId, quoteId],
  )
  const bound = await database().query(
    `SELECT quote_id FROM plot_jobs WHERE transaction_id = $1`, [transactionId])
  if (bound.rowCount !== 1 || bound.rows[0].quote_id !== quoteId) {
    throw new PlotJobError('PLOT_RESERVATION_LOST', 'Settled transaction belongs to another plot job')
  }
}

async function assertSettledPurchase(input: {
  transactionId: string; quoteId: string; subjectPubkey: string
  requirements: PaymentRequirements; receipt: SettleResponse; policy: TesseraScope402PolicyInfo
}) {
  const purchase = await database().query(
    `SELECT quote.subject_pubkey, quote.scope402_extension, quote.requirements, redemption.receipt
     FROM payment_quotes AS quote
     JOIN payment_redemptions AS redemption ON redemption.quote_id = quote.quote_id
     WHERE quote.quote_id = $1 AND quote.merchant_id = $2
       AND redemption.transaction_id = $3 AND redemption.status = 'settled'`,
    [input.quoteId, TESSERA_MERCHANT_ID, input.transactionId],
  )
  if (purchase.rowCount !== 1 || purchase.rows[0].subject_pubkey !== input.subjectPubkey ||
      !isDeepStrictEqual(purchase.rows[0].requirements, input.requirements) ||
      !isDeepStrictEqual(purchase.rows[0].receipt, input.receipt)) {
    throw new PlotJobError('PLOT_RESERVATION_LOST',
      'Root capability is not backed by this settled Tessera purchase')
  }
  const stored = parseTesseraScope402Extension(purchase.rows[0].scope402_extension)
  if (!exactPolicyEcho(stored.scope402.info, input.policy)) {
    throw new PlotJobError('PLOT_RESERVATION_LOST',
      'Root capability policy differs from the settled Tessera purchase')
  }
}

async function claimJob(transactionId: string) {
  const claimed = await database().query(
    `UPDATE plot_jobs SET status = 'running', run_started_at = now(), updated_at = now(),
       last_error = NULL
     WHERE transaction_id = $1 AND (
       status IN ('pending', 'retryable_failed') OR
       (status = 'running' AND run_started_at < now() - interval '2 minutes')
     ) RETURNING status`,
    [transactionId],
  )
  if (claimed.rowCount === 1) return { kind: 'claimed' as const }
  const current = await database().query(
    `SELECT status, result FROM plot_jobs WHERE transaction_id = $1`, [transactionId])
  if (current.rowCount === 1 && current.rows[0].status === 'complete') {
    return { kind: 'complete' as const, result: current.rows[0].result as CompletedPlot }
  }
  throw new PlotJobError('PLOT_IN_PROGRESS', 'Paid plot fulfillment is already running')
}

export async function fulfillPaidPlot(input: {
  transactionId: string
  quoteId: string
  subjectPubkey: string
  requirements: PaymentRequirements
  receipt: SettleResponse
  policy: TesseraScope402PolicyInfo
}) {
  await assertSettledPurchase(input)
  await ensureJob(input.transactionId, input.quoteId)
  const claim = await claimJob(input.transactionId)
  if (claim.kind === 'complete') return claim.result
  try {
    const lease = await prepareRootCapability(input.policy, input.transactionId, input.quoteId)
    const result: CompletedPlot = {
      status: 'complete', canvas_id: input.policy.resource.canvasId,
      region: input.policy.resource, payment: settledPaymentDetails(input.requirements, input.receipt),
      lease: { token: lease.token, ...lease.claims },
    }
    await transaction(async (client) => {
      const allocated = await client.query(
        `UPDATE tessera_slots SET status = 'allocated', reservation_expires_at = NULL,
           transaction_id = $2
         WHERE quote_id = $1 AND status = 'pending' AND transaction_id IS NULL
         RETURNING slot`,
        [input.quoteId, input.transactionId],
      )
      if (allocated.rowCount !== 1) {
        throw new PlotJobError('PLOT_RESERVATION_LOST',
          'Paid plot quote no longer controls its reserved region')
      }
      await persistRootCapability(client, lease, TESSERA_MERCHANT_ID)
      const completed = await client.query(
        `UPDATE plot_jobs SET status = 'complete', result = $2, lease_id = $3,
           lease_token = $4, run_started_at = NULL, updated_at = now()
         WHERE transaction_id = $1 AND status = 'running'`,
        [input.transactionId, JSON.stringify(result), lease.claims.lease_id, lease.token],
      )
      if (completed.rowCount !== 1) throw new Error('Plot job changed before completion')
    })
    return result
  } catch (error) {
    await database().query(
      `UPDATE plot_jobs SET status = 'retryable_failed', last_error = $2,
         run_started_at = NULL, updated_at = now()
       WHERE transaction_id = $1 AND status = 'running'`,
      [input.transactionId, error instanceof Error ? error.message : 'Unknown plot failure'],
    )
    if (error instanceof PlotJobError) throw error
    throw new PlotJobError('PLOT_RETRYABLE',
      'Payment settled, but root capability issuance failed; retry this paid request')
  }
}
