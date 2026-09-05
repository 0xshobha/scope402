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
  reservedCalls: number
  lastDelegationCounter: number
  formatVersion?: 1 | 2
  paymentQuoteId?: string
  merchantId?: string
  hederaTransactionId: string
  parentLeaseId?: string
  rootLeaseId?: string
  rootExpired: boolean
}

export async function lockCapability(client: TransactionClient, leaseId: string) {
  const result = await client.query(
    `SELECT lease_id, subject_pubkey, policy_hash, audience, catalogue_hash, tool_ids, resource,
            format_version, payment_quote_id, merchant_id, hedera_tx_id,
            parent_lease_id, root_lease_id, reserved_calls, last_delegation_counter,
            extract(epoch from expires_at)::bigint AS expires_at,
            expires_at <= clock_timestamp() OR revoked_at IS NOT NULL AS expired,
            used_calls, max_calls, last_counter
     FROM tool_leases WHERE lease_id = $1 FOR UPDATE`,
    [leaseId],
  )
  if (result.rowCount !== 1) return undefined
  const row = result.rows[0]
  let rootExpired = false
  if (row.root_lease_id !== null && row.root_lease_id !== row.lease_id) {
    const root = await client.query(
      `SELECT expires_at <= clock_timestamp() OR revoked_at IS NOT NULL AS expired
       FROM tool_leases WHERE lease_id = $1 FOR UPDATE`, [row.root_lease_id])
    if (root.rowCount !== 1) throw new LeaseError('LEASE_REQUIRED', 'Capability root is missing')
    rootExpired = Boolean(root.rows[0].expired)
  }
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
    reservedCalls: Number(row.reserved_calls),
    lastDelegationCounter: Number(row.last_delegation_counter),
    formatVersion: row.format_version === null ? undefined : Number(row.format_version) as 1 | 2,
    paymentQuoteId: row.payment_quote_id ?? undefined, merchantId: row.merchant_id ?? undefined,
    hederaTransactionId: String(row.hedera_tx_id),
    parentLeaseId: row.parent_lease_id ?? undefined,
    rootLeaseId: row.root_lease_id ?? undefined,
    rootExpired,
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
    `UPDATE tool_leases AS lease
     SET used_calls = lease.used_calls + 1, last_counter = $2
     WHERE lease.lease_id = $1 AND lease.last_counter + 1 = $2
       AND lease.used_calls + lease.reserved_calls < lease.max_calls
       AND lease.revoked_at IS NULL AND lease.expires_at > clock_timestamp()
       AND (lease.root_lease_id IS NULL OR lease.root_lease_id = lease.lease_id OR EXISTS (
         SELECT 1 FROM tool_leases AS root
         WHERE root.lease_id = lease.root_lease_id AND root.revoked_at IS NULL
           AND root.expires_at > clock_timestamp()
       ))
     RETURNING lease_id`,
    [state.leaseId, counter],
  )
  if (result.rowCount === 1) return { kind: 'consumed' }
  const current = await client.query(
    `SELECT lease.expires_at <= clock_timestamp() OR lease.revoked_at IS NOT NULL AS expired,
            lease.used_calls, lease.reserved_calls, lease.max_calls, lease.last_counter,
            CASE WHEN lease.root_lease_id IS NULL OR lease.root_lease_id = lease.lease_id
              THEN false ELSE NOT EXISTS (
                SELECT 1 FROM tool_leases AS root
                WHERE root.lease_id = lease.root_lease_id AND root.revoked_at IS NULL
                  AND root.expires_at > clock_timestamp()
              ) END AS root_expired
     FROM tool_leases AS lease WHERE lease.lease_id = $1`,
    [state.leaseId],
  )
  if (current.rowCount !== 1) return { kind: 'state_changed' }
  const row = current.rows[0]
  if (Boolean(row.expired) || Boolean(row.root_expired)) return { kind: 'expired' }
  if (counter !== Number(row.last_counter) + 1) return { kind: 'replay' }
  if (Number(row.used_calls) + Number(row.reserved_calls) >= Number(row.max_calls)) {
    return { kind: 'exhausted' }
  }
  return { kind: 'state_changed' }
}
