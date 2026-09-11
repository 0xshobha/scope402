import type { CanvasRegion } from './policy.js'

export type TesseraMissionPixel = {
  x: number
  y: number
  color: string
  actor: 'principal' | 'worker'
}

export type TesseraMissionPlan = {
  mission: 'signal-spark'
  goal: string
  canvasId: string
  slot: number
  rootRegion: CanvasRegion
  workerRegion: CanvasRegion
  principalPixels: TesseraMissionPixel[]
  workerPixels: TesseraMissionPixel[]
  requiredCalls: number
  delegatedCalls: number
  boundaryProbe: { x: number; y: number; color: string }
}

type Territory = { slot: number; active?: boolean }

export type TesseraMissionWorld = {
  canvas_id: string
  width: number
  height: number
  regions: Territory[]
  reservations: Territory[]
}

const rootSize = 8

export function planTesseraMissionForRegion(rootRegion: CanvasRegion): TesseraMissionPlan {
  if (rootRegion.width !== rootSize || rootRegion.height !== rootSize) {
    throw new Error('Signal Spark requires an 8 x 8 root territory')
  }
  const workerRegion: CanvasRegion = {
    ...rootRegion, x: rootRegion.x + 1, y: rootRegion.y + 1, width: 3, height: 2,
  }
  const pixel = (dx: number, dy: number, color: string,
    actor: TesseraMissionPixel['actor']): TesseraMissionPixel => ({
    x: rootRegion.x + dx, y: rootRegion.y + dy, color, actor,
  })
  const principalPixels = [
    pixel(2, 0, '#FFB020', 'principal'),
    pixel(0, 2, '#FFB020', 'principal'),
    pixel(4, 2, '#FFB020', 'principal'),
    pixel(2, 3, '#FFB020', 'principal'),
    pixel(2, 4, '#FFB020', 'principal'),
  ]
  const workerPixels = [
    pixel(2, 1, '#7C4DFF', 'worker'),
    pixel(1, 2, '#7C4DFF', 'worker'),
    pixel(2, 2, '#7C4DFF', 'worker'),
    pixel(3, 2, '#7C4DFF', 'worker'),
  ]
  return {
    mission: 'signal-spark',
    goal: 'Draw an amber and violet signal spark, delegate useful work, and stay inside the purchased territory.',
    canvasId: rootRegion.canvasId,
    slot: (rootRegion.y / rootSize) * 4 + rootRegion.x / rootSize,
    rootRegion,
    workerRegion,
    principalPixels,
    workerPixels,
    requiredCalls: principalPixels.length + workerPixels.length,
    delegatedCalls: workerPixels.length,
    boundaryProbe: { x: rootRegion.x + 2, y: rootRegion.y, color: '#7C4DFF' },
  }
}

function openSlot(world: TesseraMissionWorld) {
  if (world.width < rootSize || world.height < rootSize ||
      world.width % rootSize !== 0 || world.height % rootSize !== 0) {
    throw new Error('Mission planning requires a world divided into 8 x 8 territories')
  }
  const columns = world.width / rootSize
  const slots = columns * (world.height / rootSize)
  const unavailable = new Set([
    ...world.regions.filter((region) => region.active !== false).map((region) => region.slot),
    ...world.reservations.map((region) => region.slot),
  ])
  for (let slot = 0; slot < slots; slot += 1) {
    if (!unavailable.has(slot)) return slot
  }
  throw new Error('No territory is currently available for this mission')
}

/**
 * Produces a deterministic, inspectable plan. It never reserves territory or pays.
 * The caller must still validate the merchant's exact quote and request human approval.
 */
export function planTesseraMission(world: TesseraMissionWorld): TesseraMissionPlan {
  const slot = openSlot(world)
  const columns = world.width / rootSize
  const rootRegion: CanvasRegion = {
    kind: 'canvas-region', canvasId: world.canvas_id,
    x: (slot % columns) * rootSize, y: Math.floor(slot / columns) * rootSize,
    width: rootSize, height: rootSize,
  }
  return { ...planTesseraMissionForRegion(rootRegion), slot }
}
