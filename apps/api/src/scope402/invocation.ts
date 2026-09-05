import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto'
import { canonicalJson } from '../canonical.js'
import { LeaseError } from '../lease-error.js'
import { assertP256Key, encodeJwsPart, parseCompactJws, type BaseLeaseClaims } from './lease.js'

export type Scope402Invocation = {
  lease_id: string
  tool_id: string
  counter: number
  args_hash: string
  issued_at: number
}

export function hashArgs(args: unknown) {
  return createHash('sha256').update(canonicalJson(args)).digest('hex')
}

export function signInvocation<T extends Scope402Invocation>(invocation: T,
  subjectPubkey: string, key: KeyObject) {
  assertP256Key(key)
  const header = encodeJwsPart(canonicalJson({ alg: 'ES256', subject_pubkey: subjectPubkey,
    typ: 'scope402-invocation+jws' }))
  const payload = encodeJwsPart(canonicalJson(invocation))
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`),
    { key, dsaEncoding: 'ieee-p1363' })
  return `${header}.${payload}.${encodeJwsPart(signature)}`
}

export function verifyInvocation(token: string, subjectPubkey: string): Scope402Invocation {
  const [header, payload, signature] = parseCompactJws(token)
  let protectedHeader: Record<string, unknown>
  let invocation: unknown
  try {
    protectedHeader = JSON.parse(Buffer.from(header, 'base64url').toString())
    invocation = JSON.parse(Buffer.from(payload, 'base64url').toString())
  } catch {
    throw new LeaseError('LEASE_REQUIRED', 'Invocation is not valid JSON')
  }
  if (protectedHeader.subject_pubkey !== subjectPubkey) {
    throw new LeaseError('SUBJECT_KEY_MISMATCH', 'Invocation key does not match the lease subject')
  }
  if (protectedHeader.alg !== 'ES256' || protectedHeader.typ !== 'scope402-invocation+jws') {
    throw new LeaseError('LEASE_REQUIRED', 'Invocation header is invalid')
  }
  let key: KeyObject
  try {
    key = createPublicKey({ key: Buffer.from(subjectPubkey, 'base64url'), format: 'der', type: 'spki' })
    assertP256Key(key)
  } catch {
    throw new LeaseError('SUBJECT_KEY_MISMATCH', 'Lease subject key is invalid')
  }
  if (!verify('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature, 'base64url'))) {
    throw new LeaseError('LEASE_REQUIRED', 'Invocation signature is invalid')
  }
  const value = invocation as Partial<Scope402Invocation>
  if (typeof value.lease_id !== 'string' || typeof value.tool_id !== 'string' || !value.tool_id ||
      !Number.isSafeInteger(value.counter) || Number(value.counter) < 1 ||
      typeof value.args_hash !== 'string' || !Number.isSafeInteger(value.issued_at)) {
    throw new LeaseError('LEASE_REQUIRED', 'Invocation claims are invalid')
  }
  return value as Scope402Invocation
}

export function verifyBoundInvocation<ToolId extends string>(input: {
  signature: string
  claims: BaseLeaseClaims
  counter: number
  args: unknown
  toolId: ToolId
  nowMs?: number
}) {
  const invocation = verifyInvocation(input.signature, input.claims.subject_pubkey)
  if (invocation.lease_id !== input.claims.lease_id) {
    throw new LeaseError('LEASE_REQUIRED', 'Invocation is for another lease')
  }
  if (invocation.tool_id !== input.toolId || !input.claims.tool_ids.includes(input.toolId)) {
    throw new LeaseError('TOOL_NOT_ALLOWED', 'Invocation is for another tool')
  }
  if (invocation.args_hash !== hashArgs(input.args)) {
    throw new LeaseError('ARGUMENT_HASH_MISMATCH', 'Signed arguments do not match the request')
  }
  if (invocation.counter !== input.counter) {
    throw new LeaseError('REPLAY_DETECTED', 'Signed counter does not match')
  }
  const nowSeconds = (input.nowMs ?? Date.now()) / 1000
  if (Math.abs(nowSeconds - invocation.issued_at) > 120) {
    throw new LeaseError('LEASE_REQUIRED', 'Invocation timestamp is invalid')
  }
  return invocation as Scope402Invocation & { tool_id: ToolId }
}
