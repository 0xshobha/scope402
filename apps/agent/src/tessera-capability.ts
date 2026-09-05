import { createHash, randomUUID } from 'node:crypto'
import { canonicalJson } from './canonical.js'
import type { CanvasRegion } from './policy.js'
import { attackerSubject, ephemeralSubject, type AgentSubject } from './subject.js'
import type { PreparedPlot, TesseraPlotResult } from './tessera-purchase.js'

export type TesseraActionName = 'delegate' | 'place-outside' | 'wrong-key' |
  'place-inside' | 'replay' | 'expire'

export type PublicTesseraCapability = {
  lease_id: string
  subject: string
  resource: CanvasRegion
  tool_ids: ['place_pixel']
  max_calls: number
  remaining_calls: number
  exp: number
  root_lease_id: string
  parent_lease_id?: string
  payment_quote_id: string
  hedera_tx_id: string
  policy_hash: string
}

export type TesseraActionResult = {
  sequence: number
  at: string
  action: TesseraActionName
  verdict: 'ALLOWED' | 'DENIED'
  status: 200 | 403 | 410
  code: 'CAPABILITY_DELEGATED' | 'PIXEL_PLACED' | 'OUT_OF_SCOPE' |
    'SUBJECT_KEY_MISMATCH' | 'REPLAY_DETECTED' | 'LEASE_EXPIRED'
  message: string
  remaining_calls?: number
  pixel?: { canvas_id: string; x: number; y: number; color: string; updated_at: number }
}

type ChildLease = {
  token: string
  lease_id: string
  subject_pubkey: string
  aud: string
  tool_ids: ['place_pixel']
  max_calls: number
  exp: number
  offer_id: string
  hedera_tx_id: string
  policy_hash: string
  resource: CanvasRegion
  root_lease_id: string
  parent_lease_id: string
}

export type TesseraCapabilitySession = {
  execute(action: TesseraActionName): Promise<TesseraActionResult>
  root(): PublicTesseraCapability
  child(): PublicTesseraCapability | undefined
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}

function subjectFingerprint(subjectPubkey: string) {
  return `p256:${createHash('sha256').update(subjectPubkey).digest('hex').slice(0, 16)}`
}

function publicRoot(result: TesseraPlotResult): PublicTesseraCapability {
  return {
    lease_id: result.lease.lease_id,
    subject: subjectFingerprint(result.lease.subject_pubkey),
    resource: result.lease.resource,
    tool_ids: ['place_pixel'],
    max_calls: result.lease.max_calls,
    remaining_calls: result.lease.max_calls,
    exp: result.lease.exp,
    root_lease_id: result.lease.root_lease_id,
    payment_quote_id: result.lease.offer_id,
    hedera_tx_id: result.lease.hedera_tx_id,
    policy_hash: result.lease.policy_hash,
  }
}

function publicChild(lease: ChildLease, remainingCalls: number): PublicTesseraCapability {
  return {
    lease_id: lease.lease_id, subject: subjectFingerprint(lease.subject_pubkey), resource: lease.resource,
    tool_ids: ['place_pixel'], max_calls: lease.max_calls, remaining_calls: remainingCalls,
    exp: lease.exp, root_lease_id: lease.root_lease_id, parent_lease_id: lease.parent_lease_id,
    payment_quote_id: lease.offer_id, hedera_tx_id: lease.hedera_tx_id,
    policy_hash: lease.policy_hash,
  }
}

function invocation(lease: ChildLease, args: object, counter: number) {
  return {
    lease_id: lease.lease_id,
    tool_id: 'place_pixel',
    counter,
    args_hash: createHash('sha256').update(canonicalJson(args)).digest('hex'),
    issued_at: Math.floor(Date.now() / 1_000),
  }
}

async function body(response: Response) {
  return await response.json().catch(() => null) as Record<string, unknown> | null
}

export function createTesseraCapabilitySession(prepared: PreparedPlot, result: TesseraPlotResult,
  demoControlSecret: string, request: typeof fetch = fetch,
  worker: AgentSubject = ephemeralSubject()): TesseraCapabilitySession {
  const root = publicRoot(result)
  const attacker = attackerSubject()
  const toolUrl = new URL('/v1/tools/place_pixel', prepared.requestUrl)
  const delegationUrl = new URL(`/v1/leases/${result.lease.lease_id}/delegations`, prepared.requestUrl)
  const expireUrl = new URL(`/v1/leases/${result.lease.lease_id}/expire`, prepared.requestUrl)
  let childLease: ChildLease | undefined
  let childRemaining = 0
  let successfulRequestBody: string | undefined
  let successfulOperationId: string | undefined
  let delegationRequestBody: string | undefined
  let delegationOperationId: string | undefined
  let sequence = 0

  const output = (value: Omit<TesseraActionResult, 'sequence' | 'at'>): TesseraActionResult => ({
    sequence: ++sequence, at: new Date().toISOString(), ...value,
  })

  const call = (requestBody: string, operationId?: string) => request(toolUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json',
      ...(operationId ? { 'Idempotency-Key': operationId } : {}) }, body: requestBody,
    redirect: 'error', signal: AbortSignal.timeout(20_000),
  })

  const placeBody = (args: object, counter: number, subject: AgentSubject) => {
    if (!childLease) throw new Error('Delegate the worker capability before placing pixels')
    const claims = invocation(childLease, args, counter)
    return JSON.stringify({ lease: childLease.token, args, counter, signature: subject.sign(claims) })
  }

  const denial = async (response: Response, action: TesseraActionName,
    status: 403 | 410, code: TesseraActionResult['code']) => {
    const value = await body(response)
    const actual = String(value?.error ?? 'UNKNOWN')
    if (response.status !== status || actual !== code) {
      throw new Error(`Expected HTTP ${status} ${code}; Tessera returned HTTP ${response.status} ${actual}`)
    }
    return output({ action, verdict: 'DENIED', status, code,
      message: typeof value?.message === 'string' ? value.message : code,
      remaining_calls: childRemaining })
  }

  return {
    root: () => structuredClone(root),
    child: () => childLease ? publicChild(childLease, childRemaining) : undefined,
    async execute(action) {
      if (action === 'delegate') {
        if (childLease) throw new Error('Worker capability already delegated')
        const childResource: CanvasRegion = {
          ...result.region,
          x: result.region.x + 2,
          y: result.region.y + 2,
          width: 4,
          height: 4,
        }
        const now = Math.floor(Date.now() / 1_000)
        const terms = {
          parent_lease_id: result.lease.lease_id,
          child_subject_pubkey: worker.subjectPubkey,
          resource: childResource,
          tool_ids: ['place_pixel'],
          max_calls: 1,
          expires_at: Math.min(result.lease.exp, now + 180),
          counter: 1,
          issued_at: now,
        }
        delegationRequestBody ??= JSON.stringify({ lease: result.lease.token,
          delegation: prepared.subject.signDelegation(terms) })
        delegationOperationId ??= randomUUID()
        const response = await request(delegationUrl, {
          method: 'POST', headers: { 'Content-Type': 'application/json',
            'Idempotency-Key': delegationOperationId },
          body: delegationRequestBody,
          redirect: 'error', signal: AbortSignal.timeout(20_000),
        })
        const value = await body(response)
        const lease = record(value?.lease, 'Tessera returned no delegated capability')
        if (response.status !== 200 || value?.status !== 'CAPABILITY_DELEGATED' ||
            typeof lease.token !== 'string' || typeof lease.lease_id !== 'string' ||
            lease.subject_pubkey !== worker.subjectPubkey || lease.parent_lease_id !== result.lease.lease_id ||
            lease.root_lease_id !== result.lease.root_lease_id || lease.offer_id !== result.lease.offer_id ||
            lease.hedera_tx_id !== result.lease.hedera_tx_id || lease.aud !== result.lease.aud ||
            lease.max_calls !== 1 || canonicalJson(lease.resource) !== canonicalJson(childResource) ||
            !Array.isArray(lease.tool_ids) || lease.tool_ids.length !== 1 || lease.tool_ids[0] !== 'place_pixel' ||
            !Number.isSafeInteger(lease.exp) || Number(lease.exp) > result.lease.exp ||
            typeof lease.policy_hash !== 'string') {
          throw new Error('Tessera returned an invalid delegated capability')
        }
        childLease = lease as unknown as ChildLease
        childRemaining = 1
        return output({ action, verdict: 'ALLOWED', status: 200, code: 'CAPABILITY_DELEGATED',
          message: 'Principal A delegated one contained call to the distinct Worker B key.',
          remaining_calls: childRemaining })
      }

      if (!childLease) throw new Error('Delegate the worker capability before testing it')
      const inside = { canvas_id: 'main', x: childLease.resource.x, y: childLease.resource.y,
        color: '#7C4DFF' }

      if (action === 'place-outside') {
        const outside = { ...inside, x: childLease.resource.x + childLease.resource.width }
        return denial(await call(placeBody(outside, 1, worker)), action, 403, 'OUT_OF_SCOPE')
      }
      if (action === 'wrong-key') {
        return denial(await call(placeBody(inside, 1, attacker)), action, 403, 'SUBJECT_KEY_MISMATCH')
      }
      if (action === 'place-inside') {
        successfulRequestBody ??= placeBody(inside, 1, worker)
        successfulOperationId ??= randomUUID()
        const response = await call(successfulRequestBody, successfulOperationId)
        const value = await body(response)
        if (response.status !== 200 || value?.status !== 'PIXEL_PLACED' ||
            Number(value.remaining_calls) !== 0) {
          throw new Error(`Expected PIXEL_PLACED; Tessera returned HTTP ${response.status} ${String(value?.error ?? 'UNKNOWN')}`)
        }
        childRemaining = 0
        return output({ action, verdict: 'ALLOWED', status: 200, code: 'PIXEL_PLACED',
          message: 'Worker B used its single delegated call inside the child rectangle.',
          remaining_calls: 0,
          pixel: record(value.pixel, 'Tessera returned no committed pixel') as TesseraActionResult['pixel'] })
      }
      if (action === 'replay') {
        if (!successfulRequestBody) throw new Error('Place the authorized pixel before replaying it')
        return denial(await call(successfulRequestBody), action, 403, 'REPLAY_DETECTED')
      }
      if (!demoControlSecret || demoControlSecret.length < 32) {
        throw new Error('Tessera expiry control is not configured')
      }
      const expired = await request(expireUrl, {
        method: 'POST', headers: { Authorization: `Bearer ${demoControlSecret}` },
        redirect: 'error', signal: AbortSignal.timeout(20_000),
      })
      if (!expired.ok) throw new Error(expired.status === 404 ?
        'Demo controls are disabled on Tessera' : `Tessera expiry control returned HTTP ${expired.status}`)
      return denial(await call(placeBody(inside, 2, worker)), action, 410, 'LEASE_EXPIRED')
    },
  }
}
