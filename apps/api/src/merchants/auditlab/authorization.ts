import type { TransactionClient } from '../../db.js'
import { LeaseError } from '../../lease-error.js'
import { authorizeAndCommitInTransaction } from '../../scope402/authorize.js'
import type { Scope402Invocation } from '../../scope402/invocation.js'
import type { BaseLeaseClaims } from '../../scope402/lease.js'

export type AuditLabLeaseClaims = BaseLeaseClaims & {
  tool_ids: ['finding_details']
  max_calls: 3
  scan_id: string
}

type FindingArgs = { finding_id: string }

export async function authorizeAuditLabInvocation(client: TransactionClient,
  claims: AuditLabLeaseClaims, invocation: Scope402Invocation, args: FindingArgs) {
  return authorizeAndCommitInTransaction(client, claims, invocation, args, {
    authorizeResourceAction: async (transactionClient, context) => {
      const result = await transactionClient.query(
        `SELECT scan_id, hedera_tx_id, findings FROM tool_leases WHERE lease_id = $1`,
        [context.state.leaseId],
      )
      if (result.rowCount !== 1 || result.rows[0].scan_id !== claims.scan_id ||
          result.rows[0].hedera_tx_id !== claims.hedera_tx_id) {
        throw new LeaseError('REPLAY_DETECTED', 'Invocation counter is not the next counter')
      }
      const findings = result.rows[0].findings as unknown[]
      const findingExists = findings.some(
        (value) => (value as Record<string, unknown>)?.id === context.args.finding_id,
      )
      if (!findingExists) {
        throw new LeaseError('FINDING_NOT_FOUND', 'Finding does not exist in this scan')
      }
      return findings
    },
    commitBusinessMutation: async (_transactionClient, _context, findings) => findings,
  }, { allowLegacyUnscopedState: true })
}
