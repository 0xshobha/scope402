import { createHash, randomUUID } from 'node:crypto'
import { canonicalJson } from '../canonical.js'
import type { TransactionClient } from '../db.js'
import { loadServiceKey, signLease, type BaseLeaseClaims } from './lease.js'
import { scope402PolicyHash, type Scope402PolicyBase } from './policy.js'

type BoundScope402Policy = Scope402PolicyBase & { policyHash: string }

export async function prepareRootCapability<Extra extends object = Record<never, never>>(
  policy: BoundScope402Policy, transactionId: string, quoteId: string, extra?: Extra) {
  const { policyHash, ...terms } = policy
  if (policyHash !== scope402PolicyHash(terms)) {
    throw new Error('Purchased Scope402 policy hash is invalid')
  }
  const now = Math.floor(Date.now() / 1000)
  const claims: BaseLeaseClaims & Extra = {
    lease_id: randomUUID(), subject_pubkey: policy.subject.publicKey, aud: policy.audience,
    catalogue_hash: createHash('sha256').update(canonicalJson(policy.tools)).digest('hex'),
    tool_ids: [...policy.tools], max_calls: policy.maxCalls, exp: now + policy.ttlSeconds,
    offer_id: quoteId, hedera_tx_id: transactionId, policy_hash: policyHash,
    resource: policy.resource, ...(extra ?? {} as Extra),
  }
  return { token: signLease(claims, await loadServiceKey()), claims }
}

export async function persistRootCapability(client: TransactionClient,
  lease: Awaited<ReturnType<typeof prepareRootCapability>>, merchantId: string) {
  const claims = lease.claims
  const result = await client.query(
    `INSERT INTO tool_leases
       (lease_id, subject_pubkey, hedera_tx_id, expires_at, max_calls, policy_hash,
        resource, audience, catalogue_hash, tool_ids, format_version, payment_quote_id, merchant_id)
     VALUES ($1, $2, $3, to_timestamp($4), $5, $6, $7, $8, $9, $10, 2, $11, $12)
     RETURNING lease_id`,
    [claims.lease_id, claims.subject_pubkey, claims.hedera_tx_id, claims.exp,
      claims.max_calls, claims.policy_hash, JSON.stringify(claims.resource), claims.aud,
      claims.catalogue_hash, JSON.stringify(claims.tool_ids), claims.offer_id, merchantId],
  )
  if (result.rowCount !== 1) throw new Error('Capability could not be persisted')
}
