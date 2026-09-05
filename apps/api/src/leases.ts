import { createHash, randomUUID, type KeyObject } from 'node:crypto'
import { canonicalJson } from './canonical.js'
import { transaction, type TransactionClient } from './db.js'
import { LeaseError } from './lease-error.js'
import { authorizeAuditLabInvocation, type AuditLabLeaseClaims } from './merchants/auditlab/authorization.js'
import { hashArgs, signInvocation as signScope402Invocation,
  verifyInvocation as verifyScope402Invocation, type Scope402Invocation } from './scope402/invocation.js'
import { loadServiceKey, signLease as signScope402Lease,
  verifyLease as verifyScope402Lease } from './scope402/lease.js'
import { parseScope402PolicyInfo, type Scope402PolicyInfo } from './scope-extension.js'

export type LeaseClaims = AuditLabLeaseClaims
export type Invocation = Scope402Invocation & { tool_id: 'finding_details' }

export { hashArgs }

export function signLease(claims: LeaseClaims, key: KeyObject) {
  return signScope402Lease(claims, key)
}

export function verifyLease(token: string, key: KeyObject): LeaseClaims {
  const value = verifyScope402Lease(token, key)
  const auditLab = value as Partial<LeaseClaims>
  if (auditLab.max_calls !== 3 || auditLab.tool_ids?.length !== 1 ||
      auditLab.tool_ids[0] !== 'finding_details' || typeof auditLab.scan_id !== 'string') {
    throw new LeaseError('LEASE_REQUIRED', 'Lease claims are invalid')
  }
  return auditLab as LeaseClaims
}

export function signInvocation(invocation: Invocation, subjectPubkey: string, key: KeyObject) {
  return signScope402Invocation(invocation, subjectPubkey, key)
}

export function verifyInvocation(token: string, subjectPubkey: string): Invocation {
  const invocation = verifyScope402Invocation(token, subjectPubkey)
  if (invocation.tool_id !== 'finding_details') {
    throw new LeaseError('LEASE_REQUIRED', 'Invocation claims are invalid')
  }
  return invocation as Invocation
}

export async function prepareLease(subjectPubkey: string, scan: { scan_id: string; findings: unknown[] },
  transactionId: string, offerId: string, policy: Scope402PolicyInfo) {
  const validatedPolicy = parseScope402PolicyInfo(policy)
  if (validatedPolicy.subject.publicKey !== subjectPubkey) {
    throw new Error('Purchased Scope402 subject does not match lease subject')
  }
  const now = Math.floor(Date.now() / 1000)
  const tools = validatedPolicy.tools
  const claims: LeaseClaims = {
    lease_id: randomUUID(), subject_pubkey: validatedPolicy.subject.publicKey,
    aud: validatedPolicy.audience,
    catalogue_hash: createHash('sha256').update(canonicalJson(tools)).digest('hex'),
    tool_ids: tools, max_calls: validatedPolicy.maxCalls,
    exp: now + validatedPolicy.ttlSeconds, offer_id: offerId,
    hedera_tx_id: transactionId, scan_id: scan.scan_id,
    policy_hash: validatedPolicy.policyHash,
  }
  return { token: signLease(claims, await loadServiceKey()), claims }
}

export async function persistLease(client: TransactionClient,
  lease: Awaited<ReturnType<typeof prepareLease>>, findings: unknown[]) {
  await client.query(
    `INSERT INTO tool_leases
       (lease_id, subject_pubkey, scan_id, hedera_tx_id, expires_at, max_calls, policy_hash, findings)
     VALUES ($1, $2, $3, $4, to_timestamp($5), $6, $7, $8)`,
    [lease.claims.lease_id, lease.claims.subject_pubkey, lease.claims.scan_id,
      lease.claims.hedera_tx_id, lease.claims.exp, lease.claims.max_calls,
      lease.claims.policy_hash, JSON.stringify(findings)],
  )
}

export async function authorizeInvocation(claims: LeaseClaims, invocation: Invocation, findingId: string) {
  return transaction((client) => authorizeAuditLabInvocation(client, claims, invocation, findingId))
}

export async function verifyServiceLease(token: string) {
  const claims = verifyLease(token, await loadServiceKey())
  const audience = new URL('/v1/tools', process.env.AUDITLAB_URL ?? 'http://127.0.0.1:3000').href
  const catalogue = createHash('sha256').update(canonicalJson(['finding_details'])).digest('hex')
  if (claims.aud !== audience || claims.catalogue_hash !== catalogue) {
    throw new LeaseError('LEASE_REQUIRED', 'Lease audience or catalogue is invalid')
  }
  return claims
}
