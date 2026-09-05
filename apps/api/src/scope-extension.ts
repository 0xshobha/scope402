import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { canonicalJson } from './canonical.js'
import type { RepositorySnapshot } from './github.js'
import { PaymentError } from './payment-error.js'

export const SCOPE402_EXTENSION_KEY = 'scope402'

const schema = {
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

export function scope402Extension(subjectPubkey: string, snapshot: RepositorySnapshot, audience: string) {
  const policy = {
    version: 1, subject: { scheme: 'p256', publicKey: subjectPubkey }, audience,
    resource: { kind: 'github-repository', id: snapshot.repo, revision: snapshot.commit_sha },
    tools: ['finding_details'], maxCalls: 3, ttlSeconds: 300,
  } as const
  const policyHash = `sha256:${createHash('sha256').update(canonicalJson(policy)).digest('hex')}`
  return { [SCOPE402_EXTENSION_KEY]: { info: { ...policy, policyHash }, schema } }
}

export function assertScope402Echo(payload: { extensions?: unknown }, expected: unknown) {
  if (!isDeepStrictEqual(payload.extensions, expected)) {
    throw new PaymentError('PAYMENT_REQUIREMENTS_MISMATCH', 'Payment does not echo the quoted Scope402 policy')
  }
}
