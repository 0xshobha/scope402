import { createHash, type KeyObject } from 'node:crypto'
import { canonicalJson } from './canonical.js'
import { transaction, type TransactionClient } from './db.js'
import { LeaseError } from './lease-error.js'
import { authorizeAuditLabInvocation, type AuditLabLeaseClaims } from './merchants/auditlab/authorization.js'
import { hashArgs, signInvocation as signScope402Invocation,
  verifyInvocation as verifyScope402Invocation, type Scope402Invocation } from './scope402/invocation.js'
import { loadServiceKey, signLease as signScope402Lease,
  verifyLease as verifyScope402Lease } from './scope402/lease.js'
import { persistRootCapability, prepareRootCapability } from './scope402/issuance.js'
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
  return prepareRootCapability(validatedPolicy, transactionId, offerId,
    { scan_id: scan.scan_id }) as Promise<{ token: string; claims: LeaseClaims }>
}

export async function persistLease(client: TransactionClient,
  lease: Awaited<ReturnType<typeof prepareLease>>, findings: unknown[]) {
  await persistRootCapability(client, lease, 'auditlab')
  const result = await client.query(
    `UPDATE tool_leases
     SET scan_id = $2, findings = $3
     WHERE lease_id = $1
     RETURNING lease_id`,
    [lease.claims.lease_id, lease.claims.scan_id, JSON.stringify(findings)],
  )
  if (result.rowCount !== 1) throw new Error('AuditLab capability could not be bound to its scan')
}

export async function authorizeInvocation(claims: LeaseClaims, invocation: Invocation, findingId: string) {
  return transaction((client) => authorizeAuditLabInvocation(
    client, claims, invocation, { finding_id: findingId }))
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
