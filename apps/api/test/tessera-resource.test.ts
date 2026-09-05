import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LeaseError } from '../src/lease-error.js'
import { authorizeCanvasPoint, containsCanvasPoint, containsCanvasRegion, parseCanvasRegion,
  rootCanvasRegion,
  TESSERA_CANVAS_ID } from '../src/merchants/tessera/resource.js'
import { scope402PolicyHash } from '../src/scope402/policy.js'

test('maps sixteen non-overlapping root regions onto the 32 by 32 canvas', () => {
  const regions = Array.from({ length: 16 }, (_, slot) => rootCanvasRegion(slot))
  assert.deepEqual(regions[0], {
    kind: 'canvas-region', canvasId: TESSERA_CANVAS_ID,
    x: 0, y: 0, width: 8, height: 8,
  })
  assert.deepEqual(regions[15], {
    kind: 'canvas-region', canvasId: TESSERA_CANVAS_ID,
    x: 24, y: 24, width: 8, height: 8,
  })
  assert.equal(new Set(regions.map(({ x, y }) => `${x}:${y}`)).size, 16)
})

test('uses half-open rectangle boundaries', () => {
  const region = rootCanvasRegion(5)
  assert.equal(containsCanvasPoint(region, { canvasId: 'main', x: 8, y: 8 }), true)
  assert.equal(containsCanvasPoint(region, { canvasId: 'main', x: 15, y: 15 }), true)
  for (const point of [
    { canvasId: 'main', x: 7, y: 8 },
    { canvasId: 'main', x: 8, y: 7 },
    { canvasId: 'main', x: 16, y: 8 },
    { canvasId: 'main', x: 8, y: 16 },
    { canvasId: 'other', x: 8, y: 8 },
  ]) assert.equal(containsCanvasPoint(region, point), false)
})

test('rejects malformed and overflowing regions and points', () => {
  for (const region of [
    { kind: 'canvas-region', canvasId: 'main', x: -1, y: 0, width: 8, height: 8 },
    { kind: 'canvas-region', canvasId: 'main', x: 0.5, y: 0, width: 8, height: 8 },
    { kind: 'canvas-region', canvasId: 'main', x: 0, y: 0, width: 0, height: 8 },
    { kind: 'canvas-region', canvasId: 'main', x: 31, y: 0, width: 2, height: 8 },
    { kind: 'canvas-region', canvasId: 'main', x: Number.MAX_SAFE_INTEGER, y: 0, width: 8, height: 8 },
    { kind: 'canvas-region', canvasId: 'other', x: 0, y: 0, width: 8, height: 8 },
  ]) assert.throws(() => parseCanvasRegion(region))

  const region = rootCanvasRegion(0)
  for (const point of [
    { canvasId: 'main', x: -1, y: 0 },
    { canvasId: 'main', x: 0.5, y: 0 },
    { canvasId: 'main', x: Number.MAX_SAFE_INTEGER, y: 0 },
    { canvasId: 'main', x: Number.NaN, y: 0 },
  ]) {
    assert.equal(containsCanvasPoint(region, point), false)
    assert.throws(() => authorizeCanvasPoint(region, point),
      (error) => error instanceof LeaseError && error.code === 'OUT_OF_SCOPE')
  }
})

test('rejects invalid slot indexes', () => {
  for (const slot of [-1, 0.5, 16, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => rootCanvasRegion(slot), /slot/)
  }
})

test('contains only rectangles that monotonically narrow the parent region', () => {
  const parent = rootCanvasRegion(5)
  for (const child of [
    { ...parent, x: 8, y: 8, width: 4, height: 4 },
    { ...parent, x: 12, y: 12, width: 4, height: 4 },
    { ...parent, x: 8, y: 12, width: 8, height: 4 },
  ]) assert.equal(containsCanvasRegion(parent, child), true)

  for (const child of [
    { ...parent, x: 7, y: 8, width: 4, height: 4 },
    { ...parent, x: 8, y: 7, width: 4, height: 4 },
    { ...parent, x: 13, y: 8, width: 4, height: 4 },
    { ...parent, x: 8, y: 13, width: 4, height: 4 },
    { ...parent, canvasId: 'other', width: 4, height: 4 },
    { ...parent, x: Number.MAX_SAFE_INTEGER, width: 4, height: 4 },
  ]) assert.equal(containsCanvasRegion(parent, child), false)
})

test('canonical policy hash changes when the resource changes', () => {
  const policy = {
    version: 1 as const,
    subject: { scheme: 'p256' as const, publicKey: 'subject' },
    audience: 'https://scope402.example/v1/tools', tools: ['place_pixel'],
    maxCalls: 12, ttlSeconds: 300, resource: rootCanvasRegion(0),
  }
  assert.notEqual(scope402PolicyHash(policy),
    scope402PolicyHash({ ...policy, resource: rootCanvasRegion(1) }))
})
