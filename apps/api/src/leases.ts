import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify, type KeyObject } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { canonicalJson } from './canonical.js'
import type { PoolClient } from 'pg'
import { database } from './db.js'
import { LeaseError } from './lease-error.js'

export type LeaseClaims = {
  lease_id: string
  subject_pubkey: string
  aud: string
  catalogue_hash: string
  tool_ids: ['finding_details']
  max_calls: 3
  exp: number
  offer_id: string
  hedera_tx_id: string
  scan_id: string
}

export type Invocation = {
  lease_id: string
  tool_id: 'finding_details'
  counter: number
  args_hash: string
  issued_at: number
}

const encode = (value: string | Buffer) => Buffer.from(value).toString('base64url')

function parseCompact(value: string) {
  const parts = value.split('.')
  if (parts.length !== 3 || parts.some((part) => !part)) throw new LeaseError('LEASE_REQUIRED', 'Invalid compact JWS')
  return parts as [string, string, string]
}

function p256(key: KeyObject) {
  const publicKey = key.type === 'private' ? createPublicKey(key) : key
  if (publicKey.asymmetricKeyType !== 'ec' || publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('Signing key must be P-256')
  }
}

async function serviceKey() {
  const configured = process.env.TOOL_LEASE_PRIVATE_KEY
  const path = process.env.TOOL_LEASE_PRIVATE_KEY_PATH
  if (!configured && !path) throw new Error('Configure TOOL_LEASE_PRIVATE_KEY_PATH')
  const key = createPrivateKey(configured ?? await readFile(path!, 'utf8'))
  p256(key)
  return key
}

export function hashArgs(args: unknown) {
  return createHash('sha256').update(canonicalJson(args)).digest('hex')
}

export function signLease(claims: LeaseClaims, key: KeyObject) {
  p256(key)
  const header = encode(canonicalJson({ alg: 'ES256', typ: 'scope402-lease+jws' }))
  const payload = encode(canonicalJson(claims))
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' })
  return `${header}.${payload}.${encode(signature)}`
}

export function verifyLease(token: string, key: KeyObject): LeaseClaims {
  const [header, payload, signature] = parseCompact(token)
  let protectedHeader: unknown
  let claims: unknown
  try {
    protectedHeader = JSON.parse(Buffer.from(header, 'base64url').toString())
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString())
  } catch {
    throw new LeaseError('LEASE_REQUIRED', 'Lease is not valid JSON')
  }
  if ((protectedHeader as Record<string, unknown>)?.alg !== 'ES256' ||
      (protectedHeader as Record<string, unknown>)?.typ !== 'scope402-lease+jws' ||
      !verify('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature, 'base64url'))) {
    throw new LeaseError('LEASE_REQUIRED', 'Lease signature is invalid')
  }
  const value = claims as Partial<LeaseClaims>
  if (typeof value.lease_id !== 'string' || typeof value.subject_pubkey !== 'string' ||
      typeof value.exp !== 'number' || value.max_calls !== 3 || value.tool_ids?.[0] !== 'finding_details' ||
      typeof value.scan_id !== 'string' || typeof value.hedera_tx_id !== 'string') {
    throw new LeaseError('LEASE_REQUIRED', 'Lease claims are invalid')
  }
  return value as LeaseClaims
}

export function signInvocation(invocation: Invocation, subjectPubkey: string, key: KeyObject) {
  p256(key)
  const header = encode(canonicalJson({ alg: 'ES256', subject_pubkey: subjectPubkey,
    typ: 'scope402-invocation+jws' }))
  const payload = encode(canonicalJson(invocation))
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' })
  return `${header}.${payload}.${encode(signature)}`
}

export function verifyInvocation(token: string, subjectPubkey: string): Invocation {
  const [header, payload, signature] = parseCompact(token)
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
    p256(key)
  } catch {
    throw new LeaseError('SUBJECT_KEY_MISMATCH', 'Lease subject key is invalid')
  }
  if (!verify('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature, 'base64url'))) throw new LeaseError('LEASE_REQUIRED', 'Invocation signature is invalid')
  const value = invocation as Partial<Invocation>
  if (typeof value.lease_id !== 'string' || value.tool_id !== 'finding_details' ||
      !Number.isSafeInteger(value.counter) || typeof value.args_hash !== 'string' ||
      !Number.isSafeInteger(value.issued_at)) throw new LeaseError('LEASE_REQUIRED', 'Invocation claims are invalid')
  return value as Invocation
}

export async function prepareLease(subjectPubkey: string, scan: { scan_id: string; findings: unknown[] },
  transactionId: string, offerId: string) {
  const now = Math.floor(Date.now() / 1000)
  const claims: LeaseClaims = {
    lease_id: randomUUID(), subject_pubkey: subjectPubkey,
    aud: new URL('/v1/tools', process.env.AUDITLAB_URL ?? 'http://127.0.0.1:3000').href,
    catalogue_hash: createHash('sha256').update(canonicalJson(['finding_details'])).digest('hex'),
    tool_ids: ['finding_details'], max_calls: 3, exp: now + 300, offer_id: offerId,
    hedera_tx_id: transactionId, scan_id: scan.scan_id,
  }
  return { token: signLease(claims, await serviceKey()), claims }
}

export async function persistLease(client: PoolClient,
  lease: Awaited<ReturnType<typeof prepareLease>>, findings: unknown[]) {
  await client.query(
    `INSERT INTO tool_leases
       (lease_id, subject_pubkey, scan_id, hedera_tx_id, expires_at, max_calls, findings)
     VALUES ($1, $2, $3, $4, to_timestamp($5), $6, $7)`,
    [lease.claims.lease_id, lease.claims.subject_pubkey, lease.claims.scan_id,
      lease.claims.hedera_tx_id, lease.claims.exp, lease.claims.max_calls, JSON.stringify(findings)],
  )
}

export async function authorizeInvocation(claims: LeaseClaims, invocation: Invocation, findingId: string) {
  const result = await database().query(
    `UPDATE tool_leases SET used_calls = used_calls + 1, last_counter = $2
     WHERE lease_id = $1 AND subject_pubkey = $3 AND scan_id = $4 AND hedera_tx_id = $5
       AND revoked_at IS NULL AND expires_at > now() AND expires_at = to_timestamp($6)
       AND last_counter + 1 = $2 AND used_calls < max_calls
       AND findings @> $7::jsonb
     RETURNING findings`,
    [claims.lease_id, invocation.counter, claims.subject_pubkey, claims.scan_id,
      claims.hedera_tx_id, claims.exp, JSON.stringify([{ id: findingId }])],
  )
  if (result.rowCount === 1) return result.rows[0].findings as unknown[]
  const state = await database().query(
    `SELECT subject_pubkey, expires_at <= now() OR revoked_at IS NOT NULL AS expired,
            used_calls, max_calls, last_counter, findings
     FROM tool_leases WHERE lease_id = $1`, [claims.lease_id])
  if (state.rowCount !== 1 || state.rows[0].subject_pubkey !== claims.subject_pubkey) {
    throw new LeaseError('SUBJECT_KEY_MISMATCH', 'Lease subject does not match stored state')
  }
  if (state.rows[0].expired || claims.exp <= Math.floor(Date.now() / 1000)) {
    throw new LeaseError('LEASE_EXPIRED', 'Lease has expired')
  }
  if (invocation.counter <= Number(state.rows[0].last_counter)) {
    throw new LeaseError('REPLAY_DETECTED', 'Invocation counter was already used')
  }
  if (Number(state.rows[0].used_calls) >= Number(state.rows[0].max_calls)) {
    throw new LeaseError('BUDGET_EXHAUSTED', 'Lease call budget is exhausted')
  }
  const findingExists = (state.rows[0].findings as unknown[])
    .some((value) => (value as Record<string, unknown>)?.id === findingId)
  if (!findingExists) throw new LeaseError('FINDING_NOT_FOUND', 'Finding does not exist in this scan')
  throw new LeaseError('REPLAY_DETECTED', 'Invocation counter is not the next counter')
}

export async function verifyServiceLease(token: string) {
  const claims = verifyLease(token, await serviceKey())
  const audience = new URL('/v1/tools', process.env.AUDITLAB_URL ?? 'http://127.0.0.1:3000').href
  const catalogue = createHash('sha256').update(canonicalJson(['finding_details'])).digest('hex')
  if (claims.aud !== audience || claims.catalogue_hash !== catalogue) {
    throw new LeaseError('LEASE_REQUIRED', 'Lease audience or catalogue is invalid')
  }
  return claims
}
