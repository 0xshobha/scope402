import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { canonicalJson } from '../canonical.js'
import { LeaseError } from '../lease-error.js'
import { isScope402Resource, type Scope402Resource } from './policy.js'

export type BaseLeaseClaims = {
  lease_id: string
  subject_pubkey: string
  aud: string
  catalogue_hash: string
  tool_ids: string[]
  max_calls: number
  exp: number
  offer_id: string
  hedera_tx_id: string
  policy_hash?: string
  resource?: Scope402Resource
  parent_lease_id?: string
  root_lease_id?: string
}

export const encodeJwsPart = (value: string | Buffer) => Buffer.from(value).toString('base64url')

export function parseCompactJws(value: string) {
  const parts = value.split('.')
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new LeaseError('LEASE_REQUIRED', 'Invalid compact JWS')
  }
  return parts as [string, string, string]
}

export function assertP256Key(key: KeyObject) {
  const publicKey = key.type === 'private' ? createPublicKey(key) : key
  if (publicKey.asymmetricKeyType !== 'ec' || publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('Signing key must be P-256')
  }
}

export async function loadServiceKey() {
  const configured = process.env.TOOL_LEASE_PRIVATE_KEY
  const path = process.env.TOOL_LEASE_PRIVATE_KEY_PATH
  if (!configured && !path) throw new Error('Configure TOOL_LEASE_PRIVATE_KEY_PATH')
  const key = createPrivateKey(configured ?? await readFile(path!, 'utf8'))
  assertP256Key(key)
  return key
}

export function signLease<T extends BaseLeaseClaims>(claims: T, key: KeyObject) {
  assertP256Key(key)
  const header = encodeJwsPart(canonicalJson({ alg: 'ES256', typ: 'scope402-lease+jws' }))
  const payload = encodeJwsPart(canonicalJson(claims))
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`),
    { key, dsaEncoding: 'ieee-p1363' })
  return `${header}.${payload}.${encodeJwsPart(signature)}`
}

export function verifyLease(token: string, key: KeyObject): BaseLeaseClaims {
  const [header, payload, signature] = parseCompactJws(token)
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
  const value = claims as Partial<BaseLeaseClaims>
  if (typeof value.lease_id !== 'string' || typeof value.subject_pubkey !== 'string' ||
      typeof value.aud !== 'string' || typeof value.catalogue_hash !== 'string' ||
      !Array.isArray(value.tool_ids) || value.tool_ids.length < 1 ||
      value.tool_ids.some((tool) => typeof tool !== 'string') ||
      !Number.isSafeInteger(value.max_calls) || Number(value.max_calls) < 1 ||
      !Number.isSafeInteger(value.exp) || typeof value.offer_id !== 'string' ||
      typeof value.hedera_tx_id !== 'string' ||
      (value.parent_lease_id !== undefined && typeof value.parent_lease_id !== 'string') ||
      (value.root_lease_id !== undefined && typeof value.root_lease_id !== 'string') ||
      (value.policy_hash !== undefined && !/^sha256:[0-9a-f]{64}$/.test(value.policy_hash)) ||
      (value.resource !== undefined && !isScope402Resource(value.resource))) {
    throw new LeaseError('LEASE_REQUIRED', 'Lease claims are invalid')
  }
  return value as BaseLeaseClaims
}
