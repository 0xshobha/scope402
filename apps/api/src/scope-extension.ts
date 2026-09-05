import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { canonicalJson } from './canonical.js'
import type { RepositorySnapshot } from './github.js'
import { PaymentError } from './payment-error.js'

export const SCOPE402_EXTENSION_KEY = 'scope402'

export const SCOPE402_EXTENSION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['version', 'subject', 'audience', 'resource', 'tools', 'maxCalls', 'ttlSeconds', 'policyHash'],
  properties: {
    version: { const: 1 },
    subject: { type: 'object', additionalProperties: false, required: ['scheme', 'publicKey'],
      properties: { scheme: { const: 'p256' }, publicKey: { type: 'string' } } },
    audience: { type: 'string', format: 'uri' },
    resource: { type: 'object', additionalProperties: false, required: ['kind', 'id', 'revision'],
      properties: { kind: { const: 'github-repository' }, id: { type: 'string' },
        revision: { type: 'string', pattern: '^[0-9a-f]{40}$' } } },
    tools: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' } },
    maxCalls: { type: 'integer', minimum: 1 }, ttlSeconds: { type: 'integer', minimum: 1 },
    policyHash: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
  },
} as const

export type Scope402Policy = {
  version: 1
  subject: { scheme: 'p256'; publicKey: string }
  audience: string
  resource: { kind: 'github-repository'; id: string; revision: string }
  tools: ['finding_details']
  maxCalls: 3
  ttlSeconds: 300
}

export type Scope402PolicyInfo = Scope402Policy & { policyHash: string }
export type Scope402Extensions = {
  scope402: { info: Scope402PolicyInfo; schema: typeof SCOPE402_EXTENSION_SCHEMA }
}

export function scope402PolicyHash(policy: Scope402Policy) {
  return `sha256:${createHash('sha256').update(canonicalJson(policy)).digest('hex')}`
}

function hasExactKeys(value: unknown, keys: string[]) {
  return typeof value === 'object' && value !== null &&
    isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())
}

export function scope402Extension(subjectPubkey: string, snapshot: RepositorySnapshot, audience: string) {
  const policy: Scope402Policy = {
    version: 1, subject: { scheme: 'p256', publicKey: subjectPubkey }, audience,
    resource: { kind: 'github-repository', id: snapshot.repo, revision: snapshot.commit_sha },
    tools: ['finding_details'], maxCalls: 3, ttlSeconds: 300,
  }
  return { [SCOPE402_EXTENSION_KEY]: {
    info: { ...policy, policyHash: scope402PolicyHash(policy) }, schema: SCOPE402_EXTENSION_SCHEMA,
  } } satisfies Scope402Extensions
}

export function parseScope402Extension(value: unknown): Scope402Extensions {
  const extensions = value as Partial<Scope402Extensions> | null
  const extension = extensions?.scope402
  const info = extension?.info
  const policy = info && {
    version: info.version, subject: info.subject, audience: info.audience,
    resource: info.resource, tools: info.tools, maxCalls: info.maxCalls,
    ttlSeconds: info.ttlSeconds,
  }
  if (!extension || !info || !policy ||
      !hasExactKeys(extensions, ['scope402']) || !hasExactKeys(extension, ['info', 'schema']) ||
      !hasExactKeys(info, ['version', 'subject', 'audience', 'resource', 'tools', 'maxCalls', 'ttlSeconds', 'policyHash']) ||
      !hasExactKeys(info.subject, ['scheme', 'publicKey']) ||
      !hasExactKeys(info.resource, ['kind', 'id', 'revision']) ||
      !isDeepStrictEqual(extension.schema, SCOPE402_EXTENSION_SCHEMA) ||
      info.version !== 1 || info.subject?.scheme !== 'p256' ||
      typeof info.subject.publicKey !== 'string' || typeof info.audience !== 'string' ||
      info.resource?.kind !== 'github-repository' || typeof info.resource.id !== 'string' ||
      !/^[0-9a-f]{40}$/.test(info.resource.revision) ||
      !isDeepStrictEqual(info.tools, ['finding_details']) || info.maxCalls !== 3 ||
      info.ttlSeconds !== 300 || info.policyHash !== scope402PolicyHash(policy as Scope402Policy)) {
    throw new PaymentError('PAYMENT_STATE_ERROR', 'Stored Scope402 policy is invalid')
  }
  try {
    const audience = new URL(info.audience)
    const localHttp = audience.protocol === 'http:' &&
      (audience.hostname === '127.0.0.1' || audience.hostname === 'localhost')
    if (audience.protocol !== 'https:' && !localHttp) {
      throw new Error('Unsafe audience')
    }
  } catch {
    throw new PaymentError('PAYMENT_STATE_ERROR', 'Stored Scope402 policy audience is invalid')
  }
  return extensions as Scope402Extensions
}

export function parseScope402PolicyInfo(value: unknown): Scope402PolicyInfo {
  return parseScope402Extension({ scope402: { info: value, schema: SCOPE402_EXTENSION_SCHEMA } })
    .scope402.info
}

export function assertScope402Echo(payload: { extensions?: unknown }, expected: unknown) {
  if (!isDeepStrictEqual(payload.extensions, expected)) {
    throw new PaymentError('PAYMENT_REQUIREMENTS_MISMATCH', 'Payment does not echo the quoted Scope402 policy')
  }
}
