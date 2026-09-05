import { PaymentRequiredV2Schema } from '@x402/core/schemas'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { canonicalJson } from './canonical.js'

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

type ExpectedScope = { subjectPubkey: string; repository: string; commitSha: string; audience: string }

function hasExactKeys(value: unknown, keys: string[]) {
  return typeof value === 'object' && value !== null &&
    isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())
}

export function assertScope402Policy(required: { extensions?: Record<string, unknown> | null }, expected: ExpectedScope) {
  const extension = required.extensions?.scope402 as Record<string, unknown> | undefined
  const info = extension?.info as Record<string, unknown> | undefined
  const subject = info?.subject as Record<string, unknown> | undefined
  const resource = info?.resource as Record<string, unknown> | undefined
  const policy = info && {
    version: info.version, subject: info.subject, audience: info.audience, resource: info.resource,
    tools: info.tools, maxCalls: info.maxCalls, ttlSeconds: info.ttlSeconds,
  }
  const hash = policy ? `sha256:${createHash('sha256').update(canonicalJson(policy)).digest('hex')}` : ''
  if (!hasExactKeys(required.extensions, ['scope402']) ||
      !hasExactKeys(extension, ['info', 'schema']) ||
      !hasExactKeys(info, ['version', 'subject', 'audience', 'resource', 'tools', 'maxCalls', 'ttlSeconds', 'policyHash']) ||
      !hasExactKeys(subject, ['scheme', 'publicKey']) ||
      !hasExactKeys(resource, ['kind', 'id', 'revision']) ||
      !isDeepStrictEqual(extension?.schema, SCOPE402_EXTENSION_SCHEMA) ||
      info?.version !== 1 || subject?.scheme !== 'p256' ||
      subject.publicKey !== expected.subjectPubkey || info?.audience !== expected.audience ||
      resource?.kind !== 'github-repository' || resource.id !== expected.repository ||
      resource.revision !== expected.commitSha || !Array.isArray(info?.tools) ||
      info.tools.length !== 1 || info.tools[0] !== 'finding_details' || info.maxCalls !== 3 ||
      info.ttlSeconds !== 300 || info.policyHash !== hash) {
    throw new Error('Scope402 capability policy is missing or inconsistent with the quoted purchase')
  }
  return info
}

export function selectPayment(value: unknown, url: string, merchant: string, payer: string, limit: string) {
  if (!/^[1-9]\d*$/.test(limit) || BigInt(limit) > 100_000_000n) {
    throw new Error('MAX_PAYMENT_TINYBARS must be a positive integer at most 100000000')
  }
  if (merchant === payer) throw new Error('Payer and merchant must be separate accounts')
  const required = PaymentRequiredV2Schema.parse(value)
  const requested = new URL(url)
  const quoted = new URL(required.resource.url)
  if (quoted.origin !== requested.origin || quoted.pathname !== requested.pathname ||
      quoted.searchParams.size !== 1 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(quoted.searchParams.get('quote_id') ?? '')) {
    throw new Error('Payment resource is not a valid quote for the requested URL')
  }
  const terms = required.accepts.find((entry) => entry.scheme === 'exact' &&
    entry.network === 'hedera:testnet' && entry.asset === '0.0.0' && entry.payTo === merchant)
  if (!terms) throw new Error('No exact Hedera testnet HBAR payment to the configured merchant')
  if (!/^[1-9]\d*$/.test(terms.amount) || BigInt(terms.amount) > BigInt(limit)) {
    throw new Error('Payment exceeds the agent budget or has an invalid tinybar amount')
  }
  if (typeof terms.extra?.feePayer !== 'string' || !/^\d+\.\d+\.[1-9]\d*$/.test(terms.extra.feePayer)) {
    throw new Error('Missing or invalid facilitator fee payer')
  }
  return { required, paymentUrl: quoted, terms: { ...terms, network: 'hedera:testnet' as const, extra: terms.extra } }
}
