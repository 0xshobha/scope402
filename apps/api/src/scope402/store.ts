import type { TransactionClient } from '../db.js'
import { LeaseError } from '../lease-error.js'
import { isScope402Resource, type Scope402Resource } from './policy.js'

export type LockedCapabilityState = {
  leaseId: string
  subjectPubkey: string
  policyHash?: string
  audience?: string
  catalogueHash?: string
  toolIds?: string[]
  resource?: Scope402Resource
  expiresAt: number
  expired: boolean
  usedCalls: number
  maxCalls: number
  lastCounter: number
  formatVersion?: 1 | 2
  paymentQuoteId?: string
  merchantId?: string
  hederaTransactionId: string
}

export async function lockCapability(client: TransactionClient, leaseId: string) {
  const result = await client.query(
    `SELECT lease_id, subject_pubkey, policy_hash, audience, catalogue_hash, tool_ids, resource,
            format_version, payment_quote_id, merchant_id, hedera_tx_id,
            extract(epoch from expires_at)::bigint AS expires_at,
            expires_at <= clock_timestamp() OR revoked_at IS NOT NULL AS expired,
            used_calls, max_calls, last_counter
     FROM tool_leases WHERE lease_id = $1 FOR UPDATE`,
    [leaseId],
  )
  if (result.rowCount !== 1) return undefined
  const row = result.rows[0]
  const resource = row.resource ?? undefined
  if (resource !== undefined && !isScope402Resource(resource)) {
    throw new LeaseError('LEASE_REQUIRED', 'Persisted lease resource is invalid')
  }
  return {
    leaseId: String(row.lease_id), subjectPubkey: String(row.subject_pubkey),
    policyHash: row.policy_hash ?? undefined,
    audience: row.audience ?? undefined, catalogueHash: row.catalogue_hash ?? undefined,
    toolIds: (row.tool_ids ?? undefined) as string[] | undefined,
    resource,
    expiresAt: Number(row.expires_at), expired: Boolean(row.expired),
    usedCalls: Number(row.used_calls), maxCalls: Number(row.max_calls),
    lastCounter: Number(row.last_counter),
    formatVersion: row.format_version === null ? undefined : Number(row.format_version) as 1 | 2,
    paymentQuoteId: row.payment_quote_id ?? undefined, merchantId: row.merchant_id ?? undefined,
    hederaTransactionId: String(row.hedera_tx_id),
  } satisfies LockedCapabilityState
}

export type ConsumeCapabilityResult =
  | { kind: 'consumed' }
  | { kind: 'expired' }
  | { kind: 'replay' }
  | { kind: 'exhausted' }
  | { kind: 'state_changed' }

export async function consumeCapability(client: TransactionClient, state: LockedCapabilityState,
  counter: number): Promise<ConsumeCapabilityResult> {
  const result = await client.query(
    `UPDATE tool_leases SET used_calls = used_calls + 1, last_counter = $2
     WHERE lease_id = $1 AND last_counter + 1 = $2 AND used_calls < max_calls
       AND revoked_at IS NULL AND expires_at > clock_timestamp()
     RETURNING lease_id`,
    [state.leaseId, counter],
  )
  if (result.rowCount === 1) return { kind: 'consumed' }
  const current = await client.query(
    `SELECT expires_at <= clock_timestamp() OR revoked_at IS NOT NULL AS expired,
            used_calls, max_calls, last_counter
     FROM tool_leases WHERE lease_id = $1`,
    [state.leaseId],
  )
  if (current.rowCount !== 1) return { kind: 'state_changed' }
  const row = current.rows[0]
  if (Boolean(row.expired)) return { kind: 'expired' }
  if (counter !== Number(row.last_counter) + 1) return { kind: 'replay' }
  if (Number(row.used_calls) >= Number(row.max_calls)) return { kind: 'exhausted' }
  return { kind: 'state_changed' }
}
