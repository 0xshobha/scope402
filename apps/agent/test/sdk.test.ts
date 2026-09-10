import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ephemeralSubject } from '../src/subject.js'
import { Scope402Client, TesseraRootAuthority } from '../src/sdk.js'
import type { PreparedPlot, TesseraPlotResult } from '../src/tessera-purchase.js'

const rootSubject = ephemeralSubject()
const rootRegion = {
  kind: 'canvas-region' as const,
  canvasId: 'opal-world',
  x: 8,
  y: 8,
  width: 8,
  height: 8,
}
const rootLease = {
  token: 'root-lease-token-that-is-long-enough-for-the-client',
  lease_id: 'root-lease',
  subject_pubkey: rootSubject.subjectPubkey,
  aud: 'https://merchant.example/v1/tools',
  catalogue_hash: 'catalogue-hash',
  tool_ids: ['place_pixel'] as ['place_pixel'],
  max_calls: 12 as const,
  exp: Math.floor(Date.now() / 1_000) + 300,
  offer_id: 'quote-id',
  hedera_tx_id: '0.0.1001@1789000000.000000001',
  policy_hash: `sha256:${'a'.repeat(64)}`,
  resource: rootRegion,
  root_lease_id: 'root-lease',
}
const prepared = {
  requestUrl: 'https://merchant.example/v1/plots',
  subject: rootSubject,
  quote: { region: rootRegion },
} as unknown as PreparedPlot
const result = {
  region: rootRegion,
  lease: rootLease,
} as unknown as TesseraPlotResult

function jwsPayload(token: string) {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>
}

test('SDK delegates narrowed authority and serializes autonomous worker calls', async () => {
  const worker = ephemeralSubject()
  const childRegion = { ...rootRegion, x: 10, y: 10, width: 4, height: 4 }
  const childExp = rootLease.exp - 30
  const delegationCounters: number[] = []
  const invocationCounters: number[] = []
  const request = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    if (url.pathname.endsWith('/delegations')) {
      const terms = jwsPayload(String(body.delegation))
      delegationCounters.push(Number(terms.counter))
      return Response.json({
        status: 'CAPABILITY_DELEGATED',
        lease: {
          ...rootLease,
          token: 'child-lease-token-that-is-long-enough-for-the-client',
          lease_id: 'child-lease',
          subject_pubkey: worker.subjectPubkey,
          max_calls: 2,
          exp: childExp,
          resource: childRegion,
          root_lease_id: rootLease.lease_id,
          parent_lease_id: rootLease.lease_id,
          policy_hash: `sha256:${'b'.repeat(64)}`,
        },
        parent: { lease_id: rootLease.lease_id, reserved_calls: 2, remaining_calls: 10,
          delegation_counter: 1 },
      })
    }
    const signature = jwsPayload(String(body.signature))
    invocationCounters.push(Number(signature.counter))
    const args = body.args as { canvas_id: string; x: number; y: number; color: string }
    return Response.json({ status: 'PIXEL_PLACED', lease_id: 'child-lease',
      counter: signature.counter, remaining_calls: 2 - invocationCounters.length,
      pixel: { ...args, updated_at: 1789000000 } })
  }
  const root = new TesseraRootAuthority(prepared, result, request as typeof fetch)
  const child = await root.delegate({ worker, resource: childRegion, maxCalls: 2,
    expiresAt: childExp, idempotencyKey: '123e4567-e89b-42d3-a456-426614174111' })
  assert.deepEqual(delegationCounters, [1])
  assert.equal(root.capability().remaining_calls, 10)
  assert.equal(child.capability().subject.startsWith('p256:'), true)
  assert.equal('token' in child.capability(), false)

  const [first, second] = await Promise.all([
    child.paint({ x: 10, y: 10, color: '#7C4DFF' }, '123e4567-e89b-42d3-a456-426614174112'),
    child.paint({ x: 11, y: 10, color: '#00D3F2' }, '123e4567-e89b-42d3-a456-426614174113'),
  ])
  assert.deepEqual(invocationCounters, [1, 2])
  assert.deepEqual([first.remaining_calls, second.remaining_calls], [1, 0])
  assert.equal(child.capability().remaining_calls, 0)
})

test('SDK makes retries byte-identical and refuses idempotency-key reuse', async () => {
  const bodies: string[] = []
  const request = async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body))
    const body = JSON.parse(String(init?.body)) as { args: Record<string, unknown>; counter: number }
    return Response.json({ status: 'PIXEL_PLACED', lease_id: rootLease.lease_id,
      counter: body.counter, remaining_calls: 11,
      pixel: { ...body.args, updated_at: 1789000000 } })
  }
  const authority = new TesseraRootAuthority(prepared, result, request as typeof fetch)
  const operationId = '123e4567-e89b-42d3-a456-426614174114'
  const args = { x: 8, y: 8, color: '#C6F432' }
  await authority.paint(args, operationId)
  await authority.paint(args, operationId)
  assert.equal(bodies.length, 2)
  assert.equal(bodies[0], bodies[1])
  await assert.rejects(authority.paint({ ...args, x: 9 }, operationId),
    /reused with different pixel arguments/)
  assert.equal(bodies.length, 2)
})

test('SDK refuses capability escalation before sending a request', async () => {
  let calls = 0
  const request = async () => {
    calls += 1
    return Response.json({})
  }
  const root = new TesseraRootAuthority(prepared, result, request as typeof fetch)
  await assert.rejects(root.delegate({ worker: ephemeralSubject(), resource: rootRegion,
    maxCalls: 1, expiresAt: rootLease.exp - 1 }), /strictly contained/)
  assert.equal(calls, 0)
})

test('SDK reuses the unconsumed counter after a definitive pixel denial', async () => {
  const counters: number[] = []
  const request = async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { args: Record<string, unknown>;
      counter: number; signature: string }
    counters.push(Number(jwsPayload(body.signature).counter))
    if (body.args.x === 16) {
      return Response.json({ error: 'OUT_OF_SCOPE', message: 'Pixel is outside authority' },
        { status: 403 })
    }
    return Response.json({ status: 'PIXEL_PLACED', lease_id: rootLease.lease_id,
      counter: body.counter, remaining_calls: 11,
      pixel: { ...body.args, updated_at: 1789000000 } })
  }
  const root = new TesseraRootAuthority(prepared, result, request as typeof fetch)
  await assert.rejects(root.paint({ x: 16, y: 8, color: '#7C4DFF' },
    '123e4567-e89b-42d3-a456-426614174115'), (error: unknown) =>
    error instanceof Error && error.message === 'Pixel is outside authority')
  const placed = await root.paint({ x: 8, y: 8, color: '#7C4DFF' },
    '123e4567-e89b-42d3-a456-426614174116')
  assert.equal(placed.counter, 1)
  assert.deepEqual(counters, [1, 1])
})

test('SDK holds an uncertain pixel counter until the exact operation is recovered', async () => {
  const operationId = '123e4567-e89b-42d3-a456-426614174117'
  const bodies: string[] = []
  let attempts = 0
  const request = async (_input: string | URL | Request, init?: RequestInit) => {
    attempts += 1
    bodies.push(String(init?.body))
    if (attempts === 1) throw new Error('connection reset after delivery')
    const body = JSON.parse(String(init?.body)) as { args: Record<string, unknown>; counter: number }
    return Response.json({ status: 'PIXEL_PLACED', lease_id: rootLease.lease_id,
      counter: body.counter, remaining_calls: 11,
      pixel: { ...body.args, updated_at: 1789000000 } })
  }
  const root = new TesseraRootAuthority(prepared, result, request as typeof fetch)
  const args = { x: 8, y: 8, color: '#00D3F2' }
  await assert.rejects(root.paint(args, operationId), /delivery is uncertain/)
  await assert.rejects(root.paint({ ...args, x: 9 },
    '123e4567-e89b-42d3-a456-426614174118'), /Recover pending pixel operation/)
  const recovered = await root.paint(args, operationId)
  assert.equal(recovered.counter, 1)
  assert.equal(bodies[0], bodies[1])
})

test('SDK reuses the unconsumed delegation counter after a definitive denial', async () => {
  const firstWorker = ephemeralSubject()
  const secondWorker = ephemeralSubject()
  const childRegion = { ...rootRegion, x: 10, y: 10, width: 4, height: 4 }
  const expiresAt = rootLease.exp - 30
  const counters: number[] = []
  let calls = 0
  const request = async (_input: string | URL | Request, init?: RequestInit) => {
    calls += 1
    const body = JSON.parse(String(init?.body)) as { delegation: string }
    const terms = jwsPayload(body.delegation)
    counters.push(Number(terms.counter))
    if (calls === 1) {
      return Response.json({ error: 'CAPABILITY_BUDGET_EXCEEDED',
        message: 'Parent budget changed' }, { status: 403 })
    }
    return Response.json({
      status: 'CAPABILITY_DELEGATED',
      lease: { ...rootLease, token: 'second-child-token-that-is-long-enough',
        lease_id: 'second-child', subject_pubkey: secondWorker.subjectPubkey,
        max_calls: 1, exp: expiresAt, resource: childRegion,
        root_lease_id: rootLease.lease_id, parent_lease_id: rootLease.lease_id,
        policy_hash: `sha256:${'c'.repeat(64)}` },
      parent: { lease_id: rootLease.lease_id, reserved_calls: 1,
        remaining_calls: 11, delegation_counter: terms.counter },
    })
  }
  const root = new TesseraRootAuthority(prepared, result, request as typeof fetch)
  await assert.rejects(root.delegate({ worker: firstWorker, resource: childRegion,
    maxCalls: 1, expiresAt,
    idempotencyKey: '123e4567-e89b-42d3-a456-426614174119' }), /Parent budget changed/)
  const child = await root.delegate({ worker: secondWorker, resource: childRegion,
    maxCalls: 1, expiresAt,
    idempotencyKey: '123e4567-e89b-42d3-a456-426614174120' })
  assert.equal(child.capability().subject.startsWith('p256:'), true)
  assert.deepEqual(counters, [1, 1])
})

test('SDK holds an uncertain delegation counter until the exact operation is recovered', async () => {
  const worker = ephemeralSubject()
  const otherWorker = ephemeralSubject()
  const childRegion = { ...rootRegion, x: 10, y: 10, width: 4, height: 4 }
  const expiresAt = rootLease.exp - 30
  const operationId = '123e4567-e89b-42d3-a456-426614174121'
  const bodies: string[] = []
  let attempts = 0
  const request = async (_input: string | URL | Request, init?: RequestInit) => {
    attempts += 1
    bodies.push(String(init?.body))
    if (attempts === 1) throw new Error('connection reset after delegation')
    const body = JSON.parse(String(init?.body)) as { delegation: string }
    const terms = jwsPayload(body.delegation)
    return Response.json({
      status: 'CAPABILITY_DELEGATED',
      lease: { ...rootLease, token: 'recovered-child-token-that-is-long-enough',
        lease_id: 'recovered-child', subject_pubkey: worker.subjectPubkey,
        max_calls: 1, exp: expiresAt, resource: childRegion,
        root_lease_id: rootLease.lease_id, parent_lease_id: rootLease.lease_id,
        policy_hash: `sha256:${'d'.repeat(64)}` },
      parent: { lease_id: rootLease.lease_id, reserved_calls: 1,
        remaining_calls: 11, delegation_counter: terms.counter },
    })
  }
  const root = new TesseraRootAuthority(prepared, result, request as typeof fetch)
  const input = { worker, resource: childRegion, maxCalls: 1, expiresAt,
    idempotencyKey: operationId }
  await assert.rejects(root.delegate(input), /delivery is uncertain/)
  await assert.rejects(root.delegate({ ...input, worker: otherWorker,
    idempotencyKey: '123e4567-e89b-42d3-a456-426614174122' }),
  /Recover pending delegation/)
  const child = await root.delegate(input)
  assert.equal(child.capability().parent_lease_id, rootLease.lease_id)
  assert.equal(bodies[0], bodies[1])
})

test('SDK never increases displayed root budget when paint and delegation responses reorder', async () => {
  const worker = ephemeralSubject()
  const childRegion = { ...rootRegion, x: 10, y: 10, width: 4, height: 4 }
  const expiresAt = rootLease.exp - 30
  let releasePaint!: () => void
  const paintMayFinish = new Promise<void>((resolve) => { releasePaint = resolve })
  const request = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    if (url.pathname.endsWith('/delegations')) {
      const terms = jwsPayload(String(body.delegation))
      releasePaint()
      return Response.json({
        status: 'CAPABILITY_DELEGATED',
        lease: { ...rootLease, token: 'concurrent-child-token-that-is-long-enough',
          lease_id: 'concurrent-child', subject_pubkey: worker.subjectPubkey,
          max_calls: 2, exp: expiresAt, resource: childRegion,
          root_lease_id: rootLease.lease_id, parent_lease_id: rootLease.lease_id,
          policy_hash: `sha256:${'e'.repeat(64)}` },
        parent: { lease_id: rootLease.lease_id, reserved_calls: 2,
          remaining_calls: 9, delegation_counter: terms.counter },
      })
    }
    await paintMayFinish
    const invocationBody = body as { args: Record<string, unknown>; counter: number }
    return Response.json({ status: 'PIXEL_PLACED', lease_id: rootLease.lease_id,
      counter: invocationBody.counter, remaining_calls: 10,
      pixel: { ...invocationBody.args, updated_at: 1789000000 } })
  }
  const root = new TesseraRootAuthority(prepared, result, request as typeof fetch)
  await Promise.all([
    root.paint({ x: 8, y: 8, color: '#FFB020' },
      '123e4567-e89b-42d3-a456-426614174123'),
    root.delegate({ worker, resource: childRegion, maxCalls: 2, expiresAt,
      idempotencyKey: '123e4567-e89b-42d3-a456-426614174124' }),
  ])
  assert.equal(root.capability().remaining_calls, 9)
})

test('SDK discovers and reads validated shared Tessera worlds without payment', async () => {
  const paths: string[] = []
  const request = async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname
    paths.push(path)
    if (path === '/v1/canvases') {
      return Response.json({ canvases: [{ canvas_id: 'opal-world', name: 'Opal World',
        width: 32, height: 32, created_at: 1789000000, painted_pixels: 1,
        claimed_territories: 1 }] })
    }
    return Response.json({ canvas_id: 'opal-world', width: 32, height: 32,
      palette: ['#7C4DFF'], world: { name: 'Opal World', painted_pixels: 1,
        total_placements: 1, total_pixels: 1024, completion_percent: 0.1,
        current_painters: 1, active_territories: 1, reserved_territories: 0 },
      pixels: [{ x: 2, y: 2, color: '#7C4DFF', updated_at: 1789000001,
        agent: 'agent:123456789abc' }], regions: [], reservations: [], leaderboard: [],
      recent_activity: [] })
  }
  const client = new Scope402Client({ auditLabUrl: new URL('https://merchant.example'),
    payer: '0.0.1001', merchant: '0.0.1002', maxPaymentTinybars: '100000' },
  request as typeof fetch)
  const worlds = await client.listTesseraWorlds()
  const world = await client.readTesseraWorld('opal-world')
  assert.deepEqual(paths, ['/v1/canvases', '/v1/canvas/opal-world'])
  assert.equal(worlds[0]?.canvas_id, 'opal-world')
  assert.equal(world.pixels[0]?.color, '#7C4DFF')
})

test('SDK rejects invalid or mismatched world state before an agent can use it', async () => {
  let calls = 0
  const client = new Scope402Client({ auditLabUrl: new URL('https://merchant.example'),
    payer: '0.0.1001', merchant: '0.0.1002', maxPaymentTinybars: '100000' },
  (async () => { calls += 1; return Response.json({ canvas_id: 'another-world', width: 32,
    height: 32, palette: [], world: { name: 'Another World' }, pixels: [], regions: [],
    reservations: [], leaderboard: [], recent_activity: [] }) }) as typeof fetch)
  await assert.rejects(client.readTesseraWorld('../escape'), /canvas ID is invalid/)
  assert.equal(calls, 0)
  await assert.rejects(client.readTesseraWorld('opal-world'), /invalid world state/)
  assert.equal(calls, 1)
})

test('SDK rejects malformed nested pixels and territories before agent use', async () => {
  const client = new Scope402Client({ auditLabUrl: new URL('https://merchant.example'),
    payer: '0.0.1001', merchant: '0.0.1002', maxPaymentTinybars: '100000' },
  (async () => Response.json({ canvas_id: 'opal-world', width: 32, height: 32,
    palette: ['#7C4DFF'], world: { name: 'Opal World', painted_pixels: 1,
      total_placements: 1, total_pixels: 1024, completion_percent: 0.1,
      current_painters: 1, active_territories: 1, reserved_territories: 0 },
    pixels: [{ x: 99, y: 2, color: '#7C4DFF', updated_at: 1789000001 }],
    regions: [], reservations: [], leaderboard: [], recent_activity: [] })) as typeof fetch)
  await assert.rejects(client.readTesseraWorld('opal-world'), /invalid world state/)
})
