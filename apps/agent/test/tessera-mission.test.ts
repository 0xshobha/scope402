import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planTesseraMission } from '../src/tessera-mission.js'

test('mission planner chooses the first open territory and divides useful work', () => {
  const plan = planTesseraMission({
    canvas_id: 'opal-world', width: 32, height: 32,
    regions: [{ slot: 0 }, { slot: 2, active: false }],
    reservations: [{ slot: 1 }],
  })
  assert.equal(plan.slot, 2)
  assert.deepEqual(plan.rootRegion, { kind: 'canvas-region', canvasId: 'opal-world',
    x: 16, y: 0, width: 8, height: 8 })
  assert.deepEqual(plan.workerRegion, { kind: 'canvas-region', canvasId: 'opal-world',
    x: 17, y: 1, width: 3, height: 2 })
  assert.equal(plan.principalPixels.length, 5)
  assert.equal(plan.workerPixels.length, 4)
  assert.equal(plan.requiredCalls, 9)
  assert.equal(plan.delegatedCalls, 4)
  assert.equal(plan.workerPixels.every(({ x, y }) => x >= plan.workerRegion.x &&
    x < plan.workerRegion.x + plan.workerRegion.width && y >= plan.workerRegion.y &&
    y < plan.workerRegion.y + plan.workerRegion.height), true)
  assert.equal(plan.boundaryProbe.y < plan.workerRegion.y, true)
})

test('mission planner fails before payment when every territory is unavailable', () => {
  assert.throws(() => planTesseraMission({
    canvas_id: 'full-world', width: 16, height: 8,
    regions: [{ slot: 0 }], reservations: [{ slot: 1 }],
  }), /No territory is currently available/)
})

test('mission planner rejects incompatible world geometry', () => {
  assert.throws(() => planTesseraMission({
    canvas_id: 'odd-world', width: 31, height: 32, regions: [], reservations: [],
  }), /divided into 8 x 8 territories/)
})
