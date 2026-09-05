import type { RepositorySnapshot } from './github.js'
import { PaymentError } from './payment-error.js'
import { exactPolicyEcho, hasExactKeys, scope402PolicyHash as hashPolicy,
  isScope402Resource, type CanvasRegionResource, type GitHubRepositoryResource,
  type Scope402PolicyBase } from './scope402/policy.js'

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

export const TESSERA_SCOPE402_EXTENSION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['version', 'subject', 'audience', 'resource', 'tools', 'maxCalls', 'ttlSeconds', 'policyHash'],
  properties: {
    version: { const: 1 },
    subject: { type: 'object', additionalProperties: false, required: ['scheme', 'publicKey'],
      properties: { scheme: { const: 'p256' }, publicKey: { type: 'string' } } },
    audience: { type: 'string', format: 'uri' },
    resource: { type: 'object', additionalProperties: false,
      required: ['kind', 'canvasId', 'x', 'y', 'width', 'height'],
      properties: { kind: { const: 'canvas-region' }, canvasId: { type: 'string' },
        x: { type: 'integer', minimum: 0 }, y: { type: 'integer', minimum: 0 },
        width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 } } },
    tools: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' } },
    maxCalls: { type: 'integer', minimum: 1 }, ttlSeconds: { type: 'integer', minimum: 1 },
    policyHash: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
  },
} as const

export type Scope402Policy = Scope402PolicyBase<GitHubRepositoryResource> & {
  tools: ['finding_details']; maxCalls: 3; ttlSeconds: 300
}

export type Scope402PolicyInfo = Scope402Policy & { policyHash: string }
export type Scope402Extensions = {
  scope402: { info: Scope402PolicyInfo; schema: typeof SCOPE402_EXTENSION_SCHEMA }
}

export type TesseraScope402Policy = Scope402PolicyBase<CanvasRegionResource> & {
  tools: ['place_pixel']; maxCalls: 12; ttlSeconds: 300
}
export type TesseraScope402PolicyInfo = TesseraScope402Policy & { policyHash: string }
export type TesseraScope402Extensions = {
  scope402: { info: TesseraScope402PolicyInfo; schema: typeof TESSERA_SCOPE402_EXTENSION_SCHEMA }
}

export function scope402PolicyHash(policy: Scope402Policy) {
  return hashPolicy(policy)
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

export function tesseraScope402Extension(subjectPubkey: string, resource: CanvasRegionResource,
  audience: string) {
  const policy: TesseraScope402Policy = {
    version: 1, subject: { scheme: 'p256', publicKey: subjectPubkey }, audience, resource,
    tools: ['place_pixel'], maxCalls: 12, ttlSeconds: 300,
  }
  return { [SCOPE402_EXTENSION_KEY]: {
    info: { ...policy, policyHash: hashPolicy(policy) }, schema: TESSERA_SCOPE402_EXTENSION_SCHEMA,
  } } satisfies TesseraScope402Extensions
}

function assertSafeAudience(value: string) {
  try {
    const audience = new URL(value)
    const localHttp = audience.protocol === 'http:' &&
      (audience.hostname === '127.0.0.1' || audience.hostname === 'localhost')
    if (audience.protocol !== 'https:' && !localHttp) throw new Error('Unsafe audience')
  } catch {
    throw new PaymentError('PAYMENT_STATE_ERROR', 'Stored Scope402 policy audience is invalid')
  }
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
      !exactPolicyEcho(extension.schema, SCOPE402_EXTENSION_SCHEMA) ||
      info.version !== 1 || info.subject?.scheme !== 'p256' ||
      typeof info.subject.publicKey !== 'string' || typeof info.audience !== 'string' ||
      info.resource?.kind !== 'github-repository' || typeof info.resource.id !== 'string' ||
      !/^[0-9a-f]{40}$/.test(info.resource.revision) ||
      !exactPolicyEcho(info.tools, ['finding_details']) || info.maxCalls !== 3 ||
      info.ttlSeconds !== 300 || info.policyHash !== scope402PolicyHash(policy as Scope402Policy)) {
    throw new PaymentError('PAYMENT_STATE_ERROR', 'Stored Scope402 policy is invalid')
  }
  assertSafeAudience(info.audience)
  return extensions as Scope402Extensions
}

export function parseTesseraScope402Extension(value: unknown): TesseraScope402Extensions {
  const extensions = value as Partial<TesseraScope402Extensions> | null
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
      !exactPolicyEcho(extension.schema, TESSERA_SCOPE402_EXTENSION_SCHEMA) ||
      info.version !== 1 || info.subject?.scheme !== 'p256' ||
      typeof info.subject.publicKey !== 'string' || typeof info.audience !== 'string' ||
      !isScope402Resource(info.resource) || info.resource.kind !== 'canvas-region' ||
      !exactPolicyEcho(info.tools, ['place_pixel']) || info.maxCalls !== 12 ||
      info.ttlSeconds !== 300 || info.policyHash !== hashPolicy(policy as TesseraScope402Policy)) {
    throw new PaymentError('PAYMENT_STATE_ERROR', 'Stored Tessera Scope402 policy is invalid')
  }
  assertSafeAudience(info.audience)
  return extensions as TesseraScope402Extensions
}

export function parseScope402PolicyInfo(value: unknown): Scope402PolicyInfo {
  return parseScope402Extension({ scope402: { info: value, schema: SCOPE402_EXTENSION_SCHEMA } })
    .scope402.info
}

export function assertScope402Echo(payload: { extensions?: unknown }, expected: unknown) {
  if (!exactPolicyEcho(payload.extensions, expected)) {
    throw new PaymentError('PAYMENT_REQUIREMENTS_MISMATCH', 'Payment does not echo the quoted Scope402 policy')
  }
}
