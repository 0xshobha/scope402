import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { canonicalJson } from '../canonical.js'

export type Scope402Subject = { scheme: 'p256'; publicKey: string }

export type Scope402PolicyBase<Resource = unknown> = {
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
