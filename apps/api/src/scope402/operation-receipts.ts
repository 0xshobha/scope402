import { createHash } from 'node:crypto'
import { canonicalJson } from '../canonical.js'
import { database, type TransactionClient } from '../db.js'
import { LeaseError } from '../lease-error.js'

export type OperationReceipt = {
  id: string
  kind: 'delegate_capability' | 'place_pixel'
  requestHash: string
}

export function operationReceipt(id: string | undefined,
  kind: OperationReceipt['kind'], request: unknown): OperationReceipt | undefined {
  if (id === undefined) return undefined
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new LeaseError('LEASE_REQUIRED', 'Idempotency key is invalid')
  }
  return { id, kind,
    requestHash: createHash('sha256').update(canonicalJson(request)).digest('hex') }
}

function parseResponse(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Stored operation response is invalid')
  }
  return value as Record<string, unknown>
}

export async function readOperationReceipt(receipt: OperationReceipt | undefined) {
  if (!receipt) return undefined
  const result = await database().query(
    `SELECT operation_kind, request_hash, response
     FROM scope402_operation_receipts WHERE operation_id = $1`,
    [receipt.id],
  )
  if (result.rowCount !== 1) return undefined
  const row = result.rows[0]
  if (row.operation_kind !== receipt.kind || row.request_hash !== receipt.requestHash) {
    throw new LeaseError('LEASE_REQUIRED', 'Idempotency key belongs to another operation')
  }
  return parseResponse(row.response)
}

export async function writeOperationReceipt(client: TransactionClient,
  receipt: OperationReceipt | undefined, response: Record<string, unknown>) {
  if (!receipt) return
  const inserted = await client.query(
    `INSERT INTO scope402_operation_receipts
       (operation_id, operation_kind, request_hash, response)
     VALUES ($1, $2, $3, $4)`,
    [receipt.id, receipt.kind, receipt.requestHash, JSON.stringify(response)],
  )
  if (inserted.rowCount !== 1) throw new Error('Operation receipt could not be persisted')
}
