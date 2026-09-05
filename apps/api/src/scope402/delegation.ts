import { createHash, createPublicKey, randomUUID, sign, verify, type KeyObject } from 'node:crypto'
import { canonicalJson } from '../canonical.js'
import { transaction } from '../db.js'
import { LeaseError } from '../lease-error.js'
import { assertP256Key, encodeJwsPart, loadServiceKey, parseCompactJws, signLease,
  type BaseLeaseClaims } from './lease.js'
import { exactPolicyEcho, hasExactKeys, isScope402Resource, type Scope402Resource } from './policy.js'
import { lockCapability } from './store.js'
import { writeOperationReceipt, type OperationReceipt } from './operation-receipts.js'

export type DelegationTerms = {
  parent_lease_id: string
  child_subject_pubkey: string
  resource: Scope402Resource
  tool_ids: string[]
  max_calls: number
  expires_at: number
  counter: number
  issued_at: number
}

export type DelegatedLeaseClaims = BaseLeaseClaims & {
  parent_lease_id: string
  root_lease_id: string
  resource: Scope402Resource
  policy_hash: string
}

function publicKey(value: string) {
  try {
    const key = createPublicKey({ key: Buffer.from(value, 'base64url'), format: 'der', type: 'spki' })
    assertP256Key(key)
    return key
  } catch {
    throw new LeaseError('SUBJECT_KEY_MISMATCH', 'Delegation subject key is invalid')
  }
}

export function signDelegation(terms: DelegationTerms, subjectPubkey: string, key: KeyObject) {
  assertP256Key(key)
  const header = encodeJwsPart(canonicalJson({ alg: 'ES256', subject_pubkey: subjectPubkey,
    typ: 'scope402-delegation+jws' }))
  const payload = encodeJwsPart(canonicalJson(terms))
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`),
    { key, dsaEncoding: 'ieee-p1363' })
  return `${header}.${payload}.${encodeJwsPart(signature)}`
}

export function verifyDelegation(token: string, parentSubjectPubkey: string): DelegationTerms {
  const [header, payload, signature] = parseCompactJws(token)
  let protectedHeader: Record<string, unknown>
  let terms: unknown
  try {
    protectedHeader = JSON.parse(Buffer.from(header, 'base64url').toString())
    terms = JSON.parse(Buffer.from(payload, 'base64url').toString())
  } catch {
    throw new LeaseError('LEASE_REQUIRED', 'Delegation is not valid JSON')
  }
  if (protectedHeader.subject_pubkey !== parentSubjectPubkey) {
    throw new LeaseError('SUBJECT_KEY_MISMATCH', 'Delegation key does not match the parent subject')
  }
  if (protectedHeader.alg !== 'ES256' || protectedHeader.typ !== 'scope402-delegation+jws' ||
      !verify('sha256', Buffer.from(`${header}.${payload}`),
        { key: publicKey(parentSubjectPubkey), dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature, 'base64url'))) {
    throw new LeaseError('LEASE_REQUIRED', 'Delegation signature is invalid')
  }
  if (!hasExactKeys(terms, ['parent_lease_id', 'child_subject_pubkey', 'resource', 'tool_ids',
    'max_calls', 'expires_at', 'counter', 'issued_at'])) {
    throw new LeaseError('LEASE_REQUIRED', 'Delegation terms are invalid')
  }
  const value = terms as Partial<DelegationTerms>
  if (typeof value.parent_lease_id !== 'string' ||
      typeof value.child_subject_pubkey !== 'string' || !Array.isArray(value.tool_ids) ||
      value.tool_ids.length < 1 || value.tool_ids.some((tool) => typeof tool !== 'string') ||
      !Number.isSafeInteger(value.max_calls) || Number(value.max_calls) < 1 ||
      !Number.isSafeInteger(value.expires_at) || !Number.isSafeInteger(value.counter) ||
      Number(value.counter) < 1 || !Number.isSafeInteger(value.issued_at)) {
    throw new LeaseError('LEASE_REQUIRED', 'Delegation terms are invalid')
  }
  let resource: Scope402Resource
  try {
    if (!isScope402Resource(value.resource)) throw new TypeError('Invalid child resource')
    resource = value.resource
    publicKey(value.child_subject_pubkey)
  } catch (error) {
    if (error instanceof LeaseError) throw error
    throw new LeaseError('CAPABILITY_ESCALATION_DENIED', 'Child resource is invalid')
  }
  return { ...value, resource } as DelegationTerms
}

function childPolicyHash(input: {
  parentLeaseId: string
  rootLeaseId: string
  paymentQuoteId: string
  hederaTransactionId: string
  merchantId: string
  subjectPubkey: string
  audience: string
  resource: Scope402Resource
  tools: string[]
  maxCalls: number
  expiresAt: number
}) {
  return `sha256:${createHash('sha256').update(canonicalJson({
    version: 1, parentLeaseId: input.parentLeaseId, rootLeaseId: input.rootLeaseId,
    paymentQuoteId: input.paymentQuoteId, hederaTransactionId: input.hederaTransactionId,
    merchantId: input.merchantId,
    subject: { scheme: 'p256', publicKey: input.subjectPubkey }, audience: input.audience,
    resource: input.resource, tools: input.tools, maxCalls: input.maxCalls,
    expiresAt: input.expiresAt,
  })).digest('hex')}`
}

export async function delegateCapability(parentClaims: BaseLeaseClaims, terms: DelegationTerms,
  options: {
    merchantId: string
    authorizeResource(parent: Scope402Resource, child: Scope402Resource): void
    operation?: OperationReceipt
  }) {
  if (terms.parent_lease_id !== parentClaims.lease_id) {
    throw new LeaseError('LEASE_REQUIRED', 'Delegation is for another parent capability')
  }
  if (Math.abs(Date.now() / 1000 - terms.issued_at) > 120) {
    throw new LeaseError('LEASE_REQUIRED', 'Delegation timestamp is invalid')
  }
  if (terms.child_subject_pubkey === parentClaims.subject_pubkey) {
    throw new LeaseError('CAPABILITY_ESCALATION_DENIED', 'Worker must use a distinct subject key')
  }
  const serviceKey = await loadServiceKey()
  return transaction(async (client) => {
    const state = await lockCapability(client, parentClaims.lease_id)
    if (!state || state.subjectPubkey !== parentClaims.subject_pubkey) {
      throw new LeaseError('SUBJECT_KEY_MISMATCH', 'Parent subject does not match stored state')
    }
    if (state.parentLeaseId || state.rootLeaseId !== state.leaseId ||
        parentClaims.parent_lease_id !== undefined ||
        parentClaims.root_lease_id !== state.rootLeaseId) {
      throw new LeaseError('CAPABILITY_ESCALATION_DENIED', 'Child capabilities cannot delegate')
    }
    if (state.merchantId !== options.merchantId || state.formatVersion !== 2 ||
        state.policyHash !== parentClaims.policy_hash || state.audience !== parentClaims.aud ||
        state.catalogueHash !== parentClaims.catalogue_hash ||
        !exactPolicyEcho(state.toolIds, parentClaims.tool_ids) ||
        !exactPolicyEcho(state.resource, parentClaims.resource) ||
        state.paymentQuoteId !== parentClaims.offer_id ||
        state.hederaTransactionId !== parentClaims.hedera_tx_id ||
        state.expiresAt !== parentClaims.exp || state.maxCalls !== parentClaims.max_calls) {
      throw new LeaseError('LEASE_REQUIRED', 'Parent claims do not match stored purchase state')
    }
    const now = Math.floor(Date.now() / 1000)
    if (state.expired || parentClaims.exp <= now) {
      throw new LeaseError('LEASE_EXPIRED', 'Parent capability has expired')
    }
    if (terms.counter !== state.lastDelegationCounter + 1) {
      throw new LeaseError('REPLAY_DETECTED', 'Delegation counter is not the next counter')
    }
    if (!state.resource) throw new LeaseError('LEASE_REQUIRED', 'Parent resource is missing')
    options.authorizeResource(state.resource, terms.resource)
    if (new Set(terms.tool_ids).size !== terms.tool_ids.length ||
        !terms.tool_ids.every((tool) => state.toolIds?.includes(tool)) ||
        terms.expires_at <= now || terms.expires_at > state.expiresAt) {
      throw new LeaseError('CAPABILITY_ESCALATION_DENIED', 'Child policy is not a strict attenuation')
    }
    const available = state.maxCalls - state.usedCalls - state.reservedCalls
    if (terms.max_calls > available) {
      throw new LeaseError('CAPABILITY_BUDGET_EXCEEDED', 'Child budget exceeds unreserved authority')
    }
    const rootLeaseId = state.rootLeaseId ?? state.leaseId
    const policyHash = childPolicyHash({ parentLeaseId: state.leaseId, rootLeaseId,
      paymentQuoteId: state.paymentQuoteId!, hederaTransactionId: state.hederaTransactionId,
      merchantId: options.merchantId,
      subjectPubkey: terms.child_subject_pubkey, audience: state.audience!,
      resource: terms.resource, tools: terms.tool_ids, maxCalls: terms.max_calls,
      expiresAt: terms.expires_at })
    const claims: DelegatedLeaseClaims = {
      lease_id: randomUUID(), subject_pubkey: terms.child_subject_pubkey, aud: state.audience!,
      catalogue_hash: state.catalogueHash!, tool_ids: [...terms.tool_ids],
      max_calls: terms.max_calls, exp: terms.expires_at, offer_id: state.paymentQuoteId!,
      hedera_tx_id: state.hederaTransactionId, policy_hash: policyHash,
      resource: terms.resource, parent_lease_id: state.leaseId, root_lease_id: rootLeaseId,
    }
    const token = signLease(claims, serviceKey)
    const reserved = await client.query(
      `UPDATE tool_leases
       SET reserved_calls = reserved_calls + $2, last_delegation_counter = $3
       WHERE lease_id = $1 AND parent_lease_id IS NULL
         AND last_delegation_counter + 1 = $3
         AND used_calls + reserved_calls + $2 <= max_calls
         AND revoked_at IS NULL AND expires_at > clock_timestamp()
       RETURNING reserved_calls, max_calls - used_calls - reserved_calls AS remaining_calls`,
      [state.leaseId, terms.max_calls, terms.counter],
    )
    if (reserved.rowCount !== 1) {
      throw new LeaseError('CAPABILITY_BUDGET_EXCEEDED', 'Parent authority changed before delegation')
    }
    const inserted = await client.query(
      `INSERT INTO tool_leases
         (lease_id, subject_pubkey, hedera_tx_id, expires_at, max_calls, policy_hash,
          resource, audience, catalogue_hash, tool_ids, format_version, payment_quote_id,
          merchant_id, parent_lease_id, root_lease_id)
       VALUES ($1, $2, $3, to_timestamp($4), $5, $6, $7, $8, $9, $10, 2, $11, $12, $13, $14)
       RETURNING lease_id`,
      [claims.lease_id, claims.subject_pubkey, claims.hedera_tx_id, claims.exp,
        claims.max_calls, claims.policy_hash, JSON.stringify(claims.resource), claims.aud,
        claims.catalogue_hash, JSON.stringify(claims.tool_ids), claims.offer_id,
        options.merchantId, claims.parent_lease_id, claims.root_lease_id],
    )
    if (inserted.rowCount !== 1) throw new Error('Child capability could not be persisted')
    const response = { status: 'CAPABILITY_DELEGATED' as const, lease: { token, ...claims },
      parent: { lease_id: state.leaseId, reserved_calls: Number(reserved.rows[0].reserved_calls),
        remaining_calls: Number(reserved.rows[0].remaining_calls),
        delegation_counter: terms.counter } }
    await writeOperationReceipt(client, options.operation, response)
    return response
  })
}
