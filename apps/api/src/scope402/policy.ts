import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { canonicalJson } from '../canonical.js'

export type Scope402Subject = { scheme: 'p256'; publicKey: string }

export type GitHubRepositoryResource = {
  kind: 'github-repository'
  id: string
  revision: string
}

export type CanvasRegionResource = {
  kind: 'canvas-region'
  canvasId: string
  x: number
  y: number
  width: number
  height: number
}

export type Scope402Resource = GitHubRepositoryResource | CanvasRegionResource

export function isScope402Resource(value: unknown): value is Scope402Resource {
  if (typeof value !== 'object' || value === null) return false
  const resource = value as Partial<Scope402Resource>
  if (resource.kind === 'github-repository') {
    return hasExactKeys(resource, ['kind', 'id', 'revision']) &&
      typeof resource.id === 'string' && resource.id.length > 0 &&
      typeof resource.revision === 'string' && /^[0-9a-f]{40}$/.test(resource.revision)
  }
  if (resource.kind !== 'canvas-region' ||
      !hasExactKeys(resource, ['kind', 'canvasId', 'x', 'y', 'width', 'height'])) return false
  return typeof resource.canvasId === 'string' && resource.canvasId.length > 0 &&
    Number.isSafeInteger(resource.x) && Number.isSafeInteger(resource.y) &&
    Number.isSafeInteger(resource.width) && Number.isSafeInteger(resource.height) &&
    Number(resource.x) >= 0 && Number(resource.y) >= 0 &&
    Number(resource.width) > 0 && Number(resource.height) > 0
}

export type Scope402PolicyBase<Resource extends Scope402Resource = Scope402Resource> = {
  version: 1
  subject: Scope402Subject
  audience: string
  resource: Resource
  tools: string[]
  maxCalls: number
  ttlSeconds: number
}

export function scope402PolicyHash(policy: Scope402PolicyBase) {
  return `sha256:${createHash('sha256').update(canonicalJson(policy)).digest('hex')}`
}

export function exactPolicyEcho(actual: unknown, expected: unknown) {
  return isDeepStrictEqual(actual, expected)
}

export function hasExactKeys(value: unknown, keys: string[]) {
  return typeof value === 'object' && value !== null &&
    isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())
}
