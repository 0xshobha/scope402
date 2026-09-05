import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { encodePaymentRequiredHeader } from '@x402/core/http'
import { canonicalJson } from '../src/canonical.js'
import { TESSERA_SCOPE402_EXTENSION_SCHEMA } from '../src/policy.js'
import { ephemeralSubject } from '../src/subject.js'
import { assertPreparedPlot, preparePlotPurchase } from '../src/tessera-purchase.js'

const baseUrl = new URL('https://auditlab.example')
const plotUrl = new URL('/v1/plots', baseUrl)
const paymentUrl = `${plotUrl.href}?quote_id=123e4567-e89b-42d3-a456-426614174000`
const terms = { scheme: 'exact', network: 'hedera:testnet' as const, asset: '0.0.0',
  amount: '56000', payTo: '0.0.12345', maxTimeoutSeconds: 120,
  extra: { feePayer: '0.0.67890' } }
const policy = { auditLabUrl: baseUrl, payer: '0.0.54321', merchant: '0.0.12345',
  maxPaymentTinybars: '150000' }
const region = { kind: 'canvas-region' as const, canvasId: 'main', x: 0, y: 0,
  width: 8, height: 8 }
const pricing = { base_tinybars: '50000', per_call_tinybars: '500', calls: 12 as const,
  total_tinybars: '56000' }
const discovery = {
  service: { id: 'auditlab', name: 'AuditLab' }, version: 1, network: 'hedera:testnet',
  payment: { protocol: 'x402', version: 2, facilitator: 'blocky402' },
  resources: { tessera_plot: { method: 'POST', path: '/v1/plots' } },
}

function paymentRequired(subjectPubkey: string) {
  const capability = { version: 1, subject: { scheme: 'p256', publicKey: subjectPubkey },
    audience: new URL('/v1/tools', baseUrl).href, resource: region,
    tools: ['place_pixel'], maxCalls: 12, ttlSeconds: 300 }
  return { x402Version: 2 as const, resource: { url: paymentUrl }, accepts: [terms],
    extensions: { scope402: { info: { ...capability,
      policyHash: `sha256:${createHash('sha256').update(canonicalJson(capability)).digest('hex')}` },
    schema: TESSERA_SCOPE402_EXTENSION_SCHEMA } } }
}

test('prepares a real Tessera 402 without moving HBAR', async () => {
  const subject = ephemeralSubject()
  const required = paymentRequired(subject.subjectPubkey)
  const calls: Array<{ url: string; payment?: string }> = []
  const request = (async (input, init) => {
    const url = String(input)
    calls.push({ url, payment: new Headers(init?.headers).get('PAYMENT-SIGNATURE') ?? undefined })
    if (url.endsWith('/.well-known/scope402')) return Response.json(discovery)
    assert.equal(url, plotUrl.href)
    return new Response(JSON.stringify({ ...required,
      quote: { canvas_id: 'main', region, pricing } }), {
      status: 402, headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(required) },
    })
  }) as typeof fetch
  const prepared = await preparePlotPurchase(policy, subject, request)
  assert.doesNotThrow(() => assertPreparedPlot(policy, prepared))
  assert.equal(prepared.terms.amount, '56000')
  assert.deepEqual(prepared.quote.region, region)
  assert.equal(prepared.quote.policy_hash, required.extensions.scope402.info.policyHash)
  assert.equal(calls.length, 2)
  assert.equal(calls.some((call) => call.payment), false)
})

test('rejects a Tessera policy or prepared quote changed before approval', async () => {
  const subject = ephemeralSubject()
  const required = paymentRequired(subject.subjectPubkey)
  const request = (async (input) => String(input).endsWith('/.well-known/scope402') ?
    Response.json(discovery) : new Response(JSON.stringify({ ...required,
      quote: { canvas_id: 'main', region, pricing } }), {
      status: 402, headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(required) },
    })) as typeof fetch
  const prepared = await preparePlotPurchase(policy, subject, request)
  prepared.quote.region.width = 9
  const info = (prepared.required.extensions?.scope402 as { info: { resource: { width: number } } }).info
  info.resource.width = 9
  assert.throws(() => assertPreparedPlot(policy, prepared), /policy|changed/)
})

test('rejects discovery that redirects Tessera payment off the known origin', () => {
  const hostile = { ...discovery,
    resources: { tessera_plot: { method: 'POST', path: '//evil.example/v1/plots' } } }
  const request = (async () => Response.json(hostile)) as typeof fetch
  return assert.rejects(preparePlotPurchase(policy, ephemeralSubject(), request), /advertise|origin/)
})
