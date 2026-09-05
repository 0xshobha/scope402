import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTesseraCapabilitySession } from '../src/tessera-capability.js'
import { ephemeralSubject } from '../src/subject.js'
import type { PreparedPlot, TesseraPlotResult } from '../src/tessera-purchase.js'

function setup() {
  const principal = ephemeralSubject()
  const worker = ephemeralSubject()
  const region = { kind: 'canvas-region' as const, canvasId: 'main', x: 8, y: 8,
    width: 8, height: 8 }
  const prepared = { payer: '0.0.54321', requestUrl: 'https://auditlab.example/v1/plots',
    paymentUrl: 'https://auditlab.example/v1/plots?quote_id=123e4567-e89b-42d3-a456-426614174000',
    requestBody: '{}', required: { x402Version: 2 as const, resource: {
      url: 'https://auditlab.example/v1/plots?quote_id=123e4567-e89b-42d3-a456-426614174000' },
    accepts: [] }, terms: {} as PreparedPlot['terms'], fingerprint: 'sealed', subject: principal,
    quote: { canvas_id: 'main' as const, region, pricing: { base_tinybars: '50000',
      per_call_tinybars: '500', calls: 12 as const, total_tinybars: '56000' },
    policy_hash: `sha256:${'a'.repeat(64)}` } } satisfies PreparedPlot
  const result = { status: 'complete' as const, canvas_id: 'main' as const, region,
    payment: { payer: '0.0.54321', merchant: '0.0.12345', amount_tinybars: '56000',
      transaction: '0.0.67890@1.2', hashscan_url: 'https://hashscan.io/testnet/transaction/0.0.67890-1-2' },
    lease: { token: 'private-root-lease-token-12345678901234567890', lease_id: 'root-lease',
      subject_pubkey: principal.subjectPubkey, aud: 'https://auditlab.example/v1/tools',
      catalogue_hash: 'catalogue', tool_ids: ['place_pixel'] as ['place_pixel'], max_calls: 12 as const,
      exp: Math.floor(Date.now() / 1_000) + 300,
      offer_id: '123e4567-e89b-42d3-a456-426614174000', hedera_tx_id: '0.0.67890@1.2',
      policy_hash: prepared.quote.policy_hash, resource: region, root_lease_id: 'root-lease' } } satisfies TesseraPlotResult
  return { prepared, result, worker }
}

test('Tessera session delegates a distinct worker and drives only fixed real API actions', async () => {
  const { prepared, result, worker } = setup()
  const requests: Array<{ url: string; body: string }> = []
  let successfulBody = ''
  const request = (async (input, init) => {
    const url = String(input)
    const requestBody = String(init?.body ?? '')
    requests.push({ url, body: requestBody })
    if (url.endsWith('/delegations')) {
      const sent = JSON.parse(requestBody) as { lease: string; delegation: string }
      assert.equal(sent.lease, result.lease.token)
      const terms = JSON.parse(Buffer.from(sent.delegation.split('.')[1]!, 'base64url').toString()) as {
        child_subject_pubkey: string; resource: { x: number; y: number; width: number; height: number }
        max_calls: number
      }
      assert.equal(terms.child_subject_pubkey, worker.subjectPubkey)
      assert.deepEqual(terms.resource, { ...result.region, x: 10, y: 10, width: 4, height: 4 })
      assert.equal(terms.max_calls, 1)
      return Response.json({ status: 'CAPABILITY_DELEGATED', lease: {
        token: 'private-child-lease-token-123456789012345678', lease_id: 'child-lease',
        subject_pubkey: worker.subjectPubkey, aud: result.lease.aud, tool_ids: ['place_pixel'],
        max_calls: 1, exp: result.lease.exp - 10, offer_id: result.lease.offer_id,
        hedera_tx_id: result.lease.hedera_tx_id, policy_hash: `sha256:${'b'.repeat(64)}`,
        resource: terms.resource, root_lease_id: result.lease.root_lease_id,
        parent_lease_id: result.lease.lease_id,
      }, parent: { lease_id: result.lease.lease_id, reserved_calls: 1,
        remaining_calls: 11, delegation_counter: 1 } })
    }
    if (url.endsWith('/expire')) return Response.json({ lease_id: result.lease.lease_id, status: 'expired' })
    const sent = JSON.parse(requestBody) as { args: { x: number; y: number }; counter: number; signature: string }
    if (sent.args.x === 14) return Response.json({ error: 'OUT_OF_SCOPE', message: 'outside' }, { status: 403 })
    const header = JSON.parse(Buffer.from(sent.signature.split('.')[0]!, 'base64url').toString()) as {
      subject_pubkey: string
    }
    if (header.subject_pubkey !== worker.subjectPubkey) {
      return Response.json({ error: 'SUBJECT_KEY_MISMATCH', message: 'wrong key' }, { status: 403 })
    }
    if (!successfulBody) {
      successfulBody = requestBody
      return Response.json({ status: 'PIXEL_PLACED', lease_id: 'child-lease', counter: 1,
        pixel: { canvas_id: 'main', x: 10, y: 10, color: '#7C4DFF', updated_at: 123 },
        remaining_calls: 0 })
    }
    if (requestBody === successfulBody) {
      return Response.json({ error: 'REPLAY_DETECTED', message: 'replay' }, { status: 403 })
    }
    return Response.json({ error: 'LEASE_EXPIRED', message: 'expired' }, { status: 410 })
  }) as typeof fetch
  const session = createTesseraCapabilitySession(prepared, result, 'x'.repeat(32), request, worker)
  assert.equal((await session.execute('delegate')).code, 'CAPABILITY_DELEGATED')
  assert.match(session.child()?.subject ?? '', /^p256:[0-9a-f]{16}$/)
  assert.equal((await session.execute('place-outside')).code, 'OUT_OF_SCOPE')
  assert.equal((await session.execute('wrong-key')).code, 'SUBJECT_KEY_MISMATCH')
  assert.equal((await session.execute('place-inside')).code, 'PIXEL_PLACED')
  assert.equal(session.child()?.remaining_calls, 0)
  assert.equal((await session.execute('replay')).code, 'REPLAY_DETECTED')
  assert.equal((await session.execute('expire')).code, 'LEASE_EXPIRED')
  assert.equal(requests.filter((item) => item.url.endsWith('/expire')).length, 1)
  assert.equal(requests.filter((item) => item.url.endsWith('/v1/tools/place_pixel')).length, 5)
})

test('Tessera session recovers a committed pixel with the same private operation identity', async () => {
  const { prepared, result, worker } = setup()
  let childResource: typeof result.region | undefined
  let committedBody = ''
  let committedOperation = ''
  let pixelAttempts = 0
  const request = (async (input, init) => {
    const url = String(input)
    const requestBody = String(init?.body ?? '')
    const headers = new Headers(init?.headers)
    if (url.endsWith('/delegations')) {
      const sent = JSON.parse(requestBody) as { delegation: string }
      const terms = JSON.parse(Buffer.from(sent.delegation.split('.')[1]!, 'base64url').toString()) as {
        resource: typeof result.region
      }
      childResource = terms.resource
      return Response.json({ status: 'CAPABILITY_DELEGATED', lease: {
        token: 'private-child-lease-token-123456789012345678', lease_id: 'child-lease',
        subject_pubkey: worker.subjectPubkey, aud: result.lease.aud, tool_ids: ['place_pixel'],
        max_calls: 1, exp: result.lease.exp - 10, offer_id: result.lease.offer_id,
        hedera_tx_id: result.lease.hedera_tx_id, policy_hash: `sha256:${'b'.repeat(64)}`,
        resource: childResource, root_lease_id: result.lease.root_lease_id,
        parent_lease_id: result.lease.lease_id,
      } })
    }
    pixelAttempts += 1
    if (pixelAttempts === 1) {
      committedBody = requestBody
      committedOperation = headers.get('Idempotency-Key') ?? ''
      assert.match(committedOperation, /^[0-9a-f-]{36}$/)
      throw new TypeError('response lost after commit')
    }
    if (pixelAttempts === 2) {
      assert.equal(requestBody, committedBody)
      assert.equal(headers.get('Idempotency-Key'), committedOperation)
      return Response.json({ status: 'PIXEL_PLACED', lease_id: 'child-lease', counter: 1,
        pixel: { canvas_id: 'main', x: childResource!.x, y: childResource!.y,
          color: '#7C4DFF', updated_at: 123 }, remaining_calls: 0 })
    }
    assert.equal(headers.has('Idempotency-Key'), false)
    assert.equal(requestBody, committedBody)
    return Response.json({ error: 'REPLAY_DETECTED', message: 'replay' }, { status: 403 })
  }) as typeof fetch
  const session = createTesseraCapabilitySession(prepared, result, 'x'.repeat(32), request, worker)
  await session.execute('delegate')
  await assert.rejects(session.execute('place-inside'), /response lost after commit/)
  assert.equal((await session.execute('place-inside')).code, 'PIXEL_PLACED')
  assert.equal((await session.execute('replay')).code, 'REPLAY_DETECTED')
})
