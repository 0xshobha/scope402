import { LeaseError } from '../../lease-error.js'
import { hasExactKeys, type CanvasRegionResource } from '../../scope402/policy.js'

export const TESSERA_CANVAS_ID = 'main'
export const TESSERA_CANVAS_SIZE = 32
export const TESSERA_ROOT_REGION_SIZE = 8

export type CanvasPoint = { canvasId: string; x: number; y: number }

function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value)
}

export function parseCanvasRegion(value: unknown): CanvasRegionResource {
  if (!hasExactKeys(value, ['kind', 'canvasId', 'x', 'y', 'width', 'height'])) {
    throw new TypeError('Canvas region has invalid fields')
  }
  const region = value as Partial<CanvasRegionResource>
  if (region.kind !== 'canvas-region' || region.canvasId !== TESSERA_CANVAS_ID ||
      !safeInteger(region.x) || !safeInteger(region.y) ||
      !safeInteger(region.width) || !safeInteger(region.height) ||
      region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1 ||
      region.x >= TESSERA_CANVAS_SIZE || region.y >= TESSERA_CANVAS_SIZE ||
      region.width > TESSERA_CANVAS_SIZE - region.x ||
      region.height > TESSERA_CANVAS_SIZE - region.y) {
    throw new TypeError('Canvas region is outside the Tessera canvas')
  }
  return region as CanvasRegionResource
}

export function rootCanvasRegion(slot: number): CanvasRegionResource {
  if (!Number.isSafeInteger(slot) || slot < 0 || slot >= 16) {
    throw new RangeError('Tessera slot must be an integer from 0 through 15')
  }
  const slotsPerRow = TESSERA_CANVAS_SIZE / TESSERA_ROOT_REGION_SIZE
  return parseCanvasRegion({
    kind: 'canvas-region', canvasId: TESSERA_CANVAS_ID,
    x: (slot % slotsPerRow) * TESSERA_ROOT_REGION_SIZE,
    y: Math.floor(slot / slotsPerRow) * TESSERA_ROOT_REGION_SIZE,
    width: TESSERA_ROOT_REGION_SIZE, height: TESSERA_ROOT_REGION_SIZE,
  })
}

export function containsCanvasPoint(resource: CanvasRegionResource, point: unknown) {
  let validated: CanvasRegionResource
  try {
    validated = parseCanvasRegion(resource)
  } catch {
    return false
  }
  const value = point as Partial<CanvasPoint>
  const dx = safeInteger(value?.x) ? value.x - validated.x : -1
  const dy = safeInteger(value?.y) ? value.y - validated.y : -1
  return value !== null && typeof value === 'object' && value.canvasId === validated.canvasId &&
    safeInteger(value.x) && safeInteger(value.y) && dx >= 0 && dy >= 0 &&
    dx < validated.width && dy < validated.height
}

export function authorizeCanvasPoint(resource: CanvasRegionResource, point: unknown) {
  const validated = parseCanvasRegion(resource)
  if (!containsCanvasPoint(validated, point)) {
    throw new LeaseError('OUT_OF_SCOPE', 'Pixel is outside the capability region')
  }
  return point as CanvasPoint
}

export function containsCanvasRegion(parent: CanvasRegionResource, child: CanvasRegionResource) {
  let outer: CanvasRegionResource
  let inner: CanvasRegionResource
  try {
    outer = parseCanvasRegion(parent)
    inner = parseCanvasRegion(child)
  } catch {
    return false
  }
  if (outer.canvasId !== inner.canvasId) return false
  const dx = inner.x - outer.x
  const dy = inner.y - outer.y
  return dx >= 0 && dy >= 0 &&
    inner.width <= outer.width - dx && inner.height <= outer.height - dy
}
