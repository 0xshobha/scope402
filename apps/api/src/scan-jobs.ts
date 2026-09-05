import type { PaymentRequirements, SettleResponse } from '@x402/core/types'
import { database, transaction } from './db.js'
import { scanRepository } from './github.js'
import { persistLease, prepareLease } from './leases.js'
import { settledPaymentDetails } from './payment-receipt.js'
import type { Scope402PolicyInfo } from './scope-extension.js'

export class ScanJobError extends Error {
  constructor(public readonly code: 'SCAN_IN_PROGRESS' | 'SCAN_RETRYABLE', message: string) {
    super(message)
  }
}

type Receipt = SettleResponse
type Scan = Awaited<ReturnType<typeof scanRepository>>
export type CompletedScan = Scan & {
  status: 'complete'
  payment: ReturnType<typeof settledPaymentDetails>
  lease: { token: string } & Awaited<ReturnType<typeof prepareLease>>['claims']
}

async function ensureJob(transactionId: string, quoteId: string) {
  await database().query(
    `INSERT INTO scan_jobs (transaction_id, quote_id, status)
     VALUES ($1, $2, 'pending') ON CONFLICT DO NOTHING`,
    [transactionId, quoteId],
  )
  const bound = await database().query(
    `SELECT quote_id FROM scan_jobs WHERE transaction_id = $1`, [transactionId])
  if (bound.rowCount !== 1 || bound.rows[0].quote_id !== quoteId) {
    throw new Error('Settled transaction is bound to another scan job')
  }
}

async function claimJob(transactionId: string) {
  const claimed = await database().query(
    `UPDATE scan_jobs SET status = 'running', run_started_at = now(), updated_at = now(), last_error = NULL
     WHERE transaction_id = $1 AND (
       status IN ('pending', 'retryable_failed') OR
       (status = 'running' AND run_started_at < now() - interval '2 minutes')
     ) RETURNING status`,
    [transactionId],
  )
  if (claimed.rowCount === 1) return { kind: 'claimed' as const }
  const current = await database().query(
    `SELECT status, scan_result FROM scan_jobs WHERE transaction_id = $1`, [transactionId])
  if (current.rowCount === 1 && current.rows[0].status === 'complete') {
    return { kind: 'complete' as const, result: current.rows[0].scan_result as CompletedScan }
  }
  throw new ScanJobError('SCAN_IN_PROGRESS', 'Paid scan fulfillment is already running')
}

export async function fulfillPaidScan(input: {
  transactionId: string
  quoteId: string
  repoUrl: string
  subjectPubkey: string
  requirements: PaymentRequirements
  receipt: Receipt
  policy: Scope402PolicyInfo
}, runScan: (repoUrl: string) => Promise<Scan> = scanRepository) {
  await ensureJob(input.transactionId, input.quoteId)
  const claim = await claimJob(input.transactionId)
  if (claim.kind === 'complete') return claim.result
  try {
    const scan = await runScan(input.repoUrl)
    const lease = await prepareLease(input.subjectPubkey, scan, input.transactionId, input.quoteId,
      input.policy)
    const result: CompletedScan = {
      ...scan,
      status: 'complete',
      payment: settledPaymentDetails(input.requirements, input.receipt),
      lease: { token: lease.token, ...lease.claims },
    }
    await transaction(async (client) => {
      await persistLease(client, lease, scan.findings)
      const completed = await client.query(
        `UPDATE scan_jobs SET status = 'complete', scan_result = $2, lease_id = $3,
           lease_token = $4, run_started_at = NULL, updated_at = now()
         WHERE transaction_id = $1 AND status = 'running'`,
        [input.transactionId, JSON.stringify(result), lease.claims.lease_id, lease.token],
      )
      if (completed.rowCount !== 1) throw new Error('Scan job state changed before completion')
    })
    return result
  } catch (error) {
    await database().query(
      `UPDATE scan_jobs SET status = 'retryable_failed', last_error = $2,
         run_started_at = NULL, updated_at = now()
       WHERE transaction_id = $1 AND status = 'running'`,
      [input.transactionId, error instanceof Error ? error.message : 'Unknown scan failure'],
    )
    if (error instanceof ScanJobError) throw error
    throw new ScanJobError('SCAN_RETRYABLE', 'Payment settled, but scanning failed; retry this paid request')
  }
}
