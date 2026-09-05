import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { encodePaymentRequiredHeader } from '@x402/core/http'
import { assertPreparedScan, normalizeRepositoryUrl, prepareScanPurchase } from '../src/purchase.js'
import { canonicalJson } from '../src/canonical.js'
import { ephemeralSubject } from '../src/subject.js'
import { SCOPE402_EXTENSION_SCHEMA } from '../src/policy.js'

const baseUrl = new URL('https://auditlab.example')
const quoteId = '123e4567-e89b-42d3-a456-426614174000'
const scanUrl = new URL('/v1/scans', baseUrl)
const paymentUrl = `${scanUrl.href}?quote_id=${quoteId}`
const terms = { scheme: 'exact', network: 'hedera:testnet' as const, asset: '0.0.0', amount: '50500',
  payTo: '0.0.12345', maxTimeoutSeconds: 120, extra: { feePayer: '0.0.67890' } }
const policy = { auditLabUrl: baseUrl, payer: '0.0.54321', merchant: '0.0.12345',
  maxPaymentTinybars: '150000' }
const discovery = {
  service: { id: 'auditlab', name: 'AuditLab' }, version: 1, network: 'hedera:testnet',
  payment: { protocol: 'x402', version: 2, facilitator: 'blocky402' },
  resources: { repository_scan: { method: 'POST', path: '/v1/scans' } },
}
const quote = { repository: 'owner/repo', commit_sha: 'a'.repeat(40), pricing: {
  base_tinybars: '50000', per_file_tinybars: '500', file_cap: 100,
  files_considered: 1, files_charged: 1, total_tinybars: '50500',
} }

function paymentRequired(subjectPubkey: string) {
  const capability = { version: 1, subject: { scheme: 'p256', publicKey: subjectPubkey },
    audience: new URL('/v1/tools', baseUrl).href,
    resource: { kind: 'github-repository', id: quote.repository, revision: quote.commit_sha },
    tools: ['finding_details'], maxCalls: 3, ttlSeconds: 300 }
  return { x402Version: 2 as const, resource: { url: paymentUrl }, accepts: [terms],
    extensions: { scope402: { info: { ...capability,
      policyHash: `sha256:${createHash('sha256').update(canonicalJson(capability)).digest('hex')}` },
    schema: SCOPE402_EXTENSION_SCHEMA } } }
}

test('normalizes only an exact public GitHub repository URL shape', () => {
  assert.equal(normalizeRepositoryUrl('https://github.com/owner/repo/'),
    'https://github.com/owner/repo')
  for (const value of ['https://evil.example/owner/repo', 'https://github.com/owner/repo/tree/main',
    'http://github.com/owner/repo', 'https://github.com/owner/repo?amount=1']) {
    assert.throws(() => normalizeRepositoryUrl(value), /GitHub/)
  }
})

test('prepares a real 402-shaped quote without sending a payment signature', async () => {
  const subject = ephemeralSubject()
  const required = paymentRequired(subject.subjectPubkey)
  const calls: Array<{ url: string; payment?: string }> = []
  const request = (async (input, init) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    calls.push({ url, payment: headers.get('PAYMENT-SIGNATURE') ?? undefined })
    if (url.endsWith('/.well-known/scope402')) return Response.json(discovery)
    assert.equal(url, scanUrl.href)
    return new Response(JSON.stringify({ ...required, quote }), {
      status: 402, headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(required) },
    })
  }) as typeof fetch
  const prepared = await prepareScanPurchase(policy, 'https://github.com/owner/repo',
    subject, request)
  assert.doesNotThrow(() => assertPreparedScan(policy, prepared))
  assert.equal(prepared.terms.amount, '50500')
  assert.equal(prepared.quote.commit_sha, 'a'.repeat(40))
  assert.equal(calls.length, 2)
  assert.equal(calls.some((call) => call.payment), false)
})

test('rejects a prepared quote changed before approval', async () => {
  const subject = ephemeralSubject()
  const required = paymentRequired(subject.subjectPubkey)
  const request = (async (input) => String(input).endsWith('/.well-known/scope402') ?
    Response.json(discovery) : new Response(JSON.stringify({ ...required, quote }), {
      status: 402, headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(required) },
    })) as typeof fetch
  const prepared = await prepareScanPurchase(policy, 'https://github.com/owner/repo',
    subject, request)
  ;(prepared.required.accepts[0] as { amount: string }).amount = '51000'
  assert.throws(() => assertPreparedScan(policy, prepared), /changed/)
})
