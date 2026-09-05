import type { TransactionClient } from '../../db.js'
import { LeaseError } from '../../lease-error.js'
import {
  authorizeAndCommitInTransaction,
  type LockedCapabilityState,
} from '../../scope402/authorize.js'
import type { Scope402Invocation } from '../../scope402/invocation.js'
import type { BaseLeaseClaims } from '../../scope402/lease.js'

export type AuditLabLeaseClaims = BaseLeaseClaims & {
  tool_ids: ['finding_details']
  max_calls: 3
  scan_id: string
}

type AuditLabCapabilityState = LockedCapabilityState & {
  leaseId: string
  scanId: string
  hederaTransactionId: string
  findings: unknown[]
}

function number(value: unknown) {
  return Number(value)
}

async function lockCapability(client: TransactionClient, leaseId: string) {
  const result = await client.query(
    `SELECT lease_id, subject_pubkey, scan_id, hedera_tx_id, policy_hash,
            extract(epoch from expires_at)::bigint AS expires_at,
            expires_at <= clock_timestamp() OR revoked_at IS NOT NULL AS expired,
            used_calls, max_calls, last_counter, findings
     FROM tool_leases WHERE lease_id = $1 FOR UPDATE`,
    [leaseId],
  )
  if (result.rowCount !== 1) return undefined
  const row = result.rows[0]
  return {
    leaseId: String(row.lease_id), subjectPubkey: String(row.subject_pubkey),
    scanId: String(row.scan_id), hederaTransactionId: String(row.hedera_tx_id),
    policyHash: row.policy_hash ?? undefined, expiresAt: number(row.expires_at),
    expired: Boolean(row.expired), usedCalls: number(row.used_calls),
    maxCalls: number(row.max_calls), lastCounter: number(row.last_counter),
    findings: row.findings as unknown[],
  } satisfies AuditLabCapabilityState
}

export async function authorizeAuditLabInvocation(client: TransactionClient, claims: AuditLabLeaseClaims,
  invocation: Scope402Invocation, findingId: string) {
  return authorizeAndCommitInTransaction(client, claims, invocation, {
    lock: lockCapability,
    consume: async (transactionClient, state, counter) => {
      const result = await transactionClient.query(
        `UPDATE tool_leases SET used_calls = used_calls + 1, last_counter = $2
         WHERE lease_id = $1 AND last_counter + 1 = $2 AND used_calls < max_calls
           AND revoked_at IS NULL AND expires_at > clock_timestamp()
         RETURNING lease_id`,
        [state.leaseId, counter],
      )
      return result.rowCount === 1
    },
  }, {
    authorizeResourceAction: async (_transactionClient, state) => {
      if (state.scanId !== claims.scan_id || state.hederaTransactionId !== claims.hedera_tx_id) {
        throw new LeaseError('REPLAY_DETECTED', 'Invocation counter is not the next counter')
      }
      const findingExists = state.findings.some(
        (value) => (value as Record<string, unknown>)?.id === findingId,
      )
      if (!findingExists) {
        throw new LeaseError('FINDING_NOT_FOUND', 'Finding does not exist in this scan')
      }
      return state.findings
    },
    commitBusinessMutation: async (_transactionClient, _state, findings) => findings,
  })
}
