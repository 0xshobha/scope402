import { createHash, randomUUID } from 'node:crypto'
import { canonicalJson } from './canonical.js'
import { approvePlotPurchase, preparePlotPurchase, type PreparedPlot,
  type TesseraPlotResult } from './tessera-purchase.js'
import { approveScanPurchase, prepareScanPurchase, type AgentPolicy,
  type PreparedScan } from './purchase.js'
import { ephemeralSubject, persistentSubject, type AgentSubject } from './subject.js'
import type { CanvasRegion } from './policy.js'

export { approvePlotPurchase, preparePlotPurchase } from './tessera-purchase.js'
export type { PreparedPlot, TesseraPlotResult } from './tessera-purchase.js'
export { approveScanPurchase, prepareScanPurchase } from './purchase.js'
export type { PreparedScan, ScanResult } from './purchase.js'
export { discoverPlotResource, discoverScanResource } from './discovery.js'
export { assertTesseraScope402Policy } from './policy.js'
export { planTesseraMission } from './tessera-mission.js'
export type { TesseraMissionPixel, TesseraMissionPlan, TesseraMissionWorld } from './tessera-mission.js'
export { ephemeralSubject, persistentSubject } from './subject.js'
export type { AgentPolicy, PayerConfig } from './purchase.js'
export type { AgentSubject } from './subject.js'
export type { CanvasRegion } from './policy.js'

type Fetch = typeof fetch

export type Scope402ClientConfig = {
  auditLabUrl: URL
  payer?: string
  merchant?: string
  maxPaymentTinybars?: string
}

export type TesseraPixel = {
  canvas_id: string
  x: number
  y: number
  color: string
  updated_at: number
}

export type TesseraWorldSummary = {
  canvas_id: string
  name: string
  width: number
  height: number
  created_at: number
  painted_pixels: number
  claimed_territories: number
  location: { latitude: number; longitude: number }
}

export type TesseraWorldState = {
  canvas_id: string
  location: { latitude: number; longitude: number }
  width: number
  height: number
  palette: string[]
  world: {
    name: string
    painted_pixels: number
    total_placements: number
    total_pixels: number
    completion_percent: number
    current_painters: number
    active_territories: number
    reserved_territories: number
  }
  pixels: Array<TesseraPixel & { agent?: string }>
  regions: Array<CanvasRegion & { slot: number; lease_id: string; agent?: string;
    expires_at: number; remaining_calls: number; active: boolean; status: 'active' | 'expired' }>
  reservations: Array<CanvasRegion & { slot: number; agent: string; expires_at: number;
    status: 'reserved' }>
  leaderboard: Array<{ agent: string; placements: number; current_pixels: number; last_active: number }>
  recent_activity: Array<{ x: number; y: number; color: string; counter: number;
    painted_at: number; agent: string }>
}

export type TesseraPaintReceipt = {
  status: 'PIXEL_PLACED'
  lease_id: string
  counter: number
  remaining_calls: number
  pixel: TesseraPixel
}

export type TesseraCapabilityView = {
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

type CapabilityLease = {
  token: string
  lease_id: string
  subject_pubkey: string
  aud: string
  catalogue_hash: string
  tool_ids: ['place_pixel']
  max_calls: number
  exp: number
  offer_id: string
  hedera_tx_id: string
  policy_hash: string
  resource: CanvasRegion
  root_lease_id: string
  parent_lease_id?: string
}

type DelegatedLease = CapabilityLease & {
  parent_lease_id: string
}

type PreparedOperation = {
  counter: number
  requestBody: string
  requestHash: string
  state: 'pending' | 'committed' | 'denied'
  denial?: Scope402HttpError
}

export class Scope402HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'Scope402HttpError'
  }
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}

function safeInteger(value: unknown, minimum = 0) {
  return Number.isSafeInteger(value) && Number(value) >= minimum
}

function canvasId(value: unknown) {
  return typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/.test(value)
}

function hexColor(value: unknown) {
  return typeof value === 'string' && /^#[0-9A-F]{6}$/.test(value)
}

function agentId(value: unknown) {
  return typeof value === 'string' && /^(?:agent|p256):[0-9a-f]{12,64}$/.test(value)
}

function validLocation(value: unknown) {
  const location = record(value, 'Tessera returned an invalid geographic location')
  return Object.keys(location).sort().join(',') === 'latitude,longitude' &&
    typeof location.latitude === 'number' && Number.isFinite(location.latitude) &&
    location.latitude >= -85 && location.latitude <= 85 &&
    typeof location.longitude === 'number' && Number.isFinite(location.longitude) &&
    location.longitude >= -180 && location.longitude <= 180
}

function validPoint(value: unknown, width: number, height: number) {
  const point = record(value, 'Tessera returned an invalid pixel')
  return safeInteger(point.x) && safeInteger(point.y) && Number(point.x) < width &&
    Number(point.y) < height && hexColor(point.color) && safeInteger(point.updated_at, 1) &&
    (point.agent === undefined || agentId(point.agent))
}

function validRegion(value: unknown, expectedCanvasId: string, width: number, height: number) {
  const region = record(value, 'Tessera returned an invalid territory')
  return region.kind === 'canvas-region' && region.canvasId === expectedCanvasId &&
    safeInteger(region.x) && safeInteger(region.y) && safeInteger(region.width, 1) &&
    safeInteger(region.height, 1) && Number(region.x) + Number(region.width) <= width &&
    Number(region.y) + Number(region.height) <= height
}

function assertWorldSummary(value: unknown): TesseraWorldSummary {
  const world = record(value, 'Tessera returned an invalid world catalogue entry')
  if (!canvasId(world.canvas_id) || typeof world.name !== 'string' || !world.name ||
      !validLocation(world.location) ||
      !safeInteger(world.width, 1) || !safeInteger(world.height, 1) ||
      !safeInteger(world.created_at) || !safeInteger(world.painted_pixels) ||
      !safeInteger(world.claimed_territories)) {
    throw new Error('Tessera returned an invalid world catalogue entry')
  }
  return world as unknown as TesseraWorldSummary
}

function assertWorldState(value: unknown, expectedCanvasId: string): TesseraWorldState {
  const world = record(value, 'Tessera returned an invalid world state')
  const metrics = record(world.world, 'Tessera returned invalid world metrics')
  const arrays = ['palette', 'pixels', 'regions', 'reservations', 'leaderboard', 'recent_activity']
  const width = Number(world.width)
  const height = Number(world.height)
  if (world.canvas_id !== expectedCanvasId || !validLocation(world.location) || !safeInteger(width, 1) ||
      !safeInteger(height, 1) || typeof metrics.name !== 'string' || !metrics.name ||
      !arrays.every((field) => Array.isArray(world[field])) ||
      !(world.palette as unknown[]).every(hexColor) ||
      !(world.pixels as unknown[]).every((pixel) => validPoint(pixel, width, height)) ||
      !(world.regions as unknown[]).every((region) => {
        const item = record(region, 'Tessera returned an invalid territory')
        return safeInteger(item.slot) && safeInteger(item.expires_at, 1) &&
          typeof item.lease_id === 'string' && item.lease_id.length > 0 &&
          safeInteger(item.remaining_calls) && typeof item.active === 'boolean' &&
          (item.status === 'active' || item.status === 'expired') &&
          validRegion(item, expectedCanvasId, width, height) &&
          (item.agent === undefined || agentId(item.agent))
      }) ||
      !(world.reservations as unknown[]).every((reservation) => {
        const item = record(reservation, 'Tessera returned an invalid reservation')
        return safeInteger(item.slot) && safeInteger(item.expires_at, 1) &&
          item.status === 'reserved' && agentId(item.agent) &&
          validRegion(item, expectedCanvasId, width, height)
      }) ||
      !(world.leaderboard as unknown[]).every((entry) => {
        const item = record(entry, 'Tessera returned an invalid leaderboard entry')
        return agentId(item.agent) && safeInteger(item.placements) &&
          safeInteger(item.current_pixels) && safeInteger(item.last_active, 1)
      }) ||
      !(world.recent_activity as unknown[]).every((entry) => {
        const item = record(entry, 'Tessera returned invalid activity')
        return safeInteger(item.x) && safeInteger(item.y) && Number(item.x) < width && Number(item.y) < height &&
          hexColor(item.color) && safeInteger(item.counter, 1) && safeInteger(item.painted_at, 1) &&
          agentId(item.agent)
      }) ||
      !safeInteger(metrics.painted_pixels) || !safeInteger(metrics.total_placements) ||
      !safeInteger(metrics.total_pixels, 1) || typeof metrics.completion_percent !== 'number' ||
      !Number.isFinite(metrics.completion_percent) || metrics.completion_percent < 0 ||
      metrics.completion_percent > 100 || !safeInteger(metrics.current_painters) ||
      !safeInteger(metrics.active_territories) || !safeInteger(metrics.reserved_territories)) {
    throw new Error('Tessera returned an invalid world state')
  }
  return world as unknown as TesseraWorldState
}

async function* serverSentEvents(response: Response) {
  if (!response.body || !response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
    throw new Error('Tessera returned an invalid world event stream')
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      buffer += value ?? ''
      const frames: string[] = []
      let boundary = /\r\n\r\n|\n\n|\r\r/.exec(buffer)
      while (boundary?.index !== undefined) {
        frames.push(buffer.slice(0, boundary.index))
        buffer = buffer.slice(boundary.index + boundary[0].length)
        boundary = /\r\n\r\n|\n\n|\r\r/.exec(buffer)
      }
      for (const frame of frames) {
        let event = 'message'
        const data: string[] = []
        for (const line of frame.split(/\r\n|\n|\r/)) {
          if (line.startsWith(':')) continue
          const separator = line.indexOf(':')
          const field = separator === -1 ? line : line.slice(0, separator)
          const raw = separator === -1 ? '' : line.slice(separator + 1)
          const fieldValue = raw.startsWith(' ') ? raw.slice(1) : raw
          if (field === 'event') event = fieldValue
          if (field === 'data') data.push(fieldValue)
        }
        yield { event, data: data.join('\n') }
      }
      if (done) {
        if (buffer.trim()) throw new Error('Tessera returned a truncated world event stream')
        break
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

function subjectFingerprint(subjectPubkey: string) {
  return `p256:${createHash('sha256').update(subjectPubkey).digest('hex').slice(0, 16)}`
}

function hash(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function invocation(leaseId: string, args: object, counter: number) {
  return {
    lease_id: leaseId,
    tool_id: 'place_pixel',
    counter,
    args_hash: hash(args),
    issued_at: Math.floor(Date.now() / 1_000),
  }
}

function exactRegion(actual: unknown, expected: CanvasRegion) {
  return canonicalJson(actual) === canonicalJson(expected)
}

function containsRegion(parent: CanvasRegion, child: CanvasRegion) {
  return parent.canvasId === child.canvasId && child.x >= parent.x && child.y >= parent.y &&
    child.width > 0 && child.height > 0 &&
    child.x + child.width <= parent.x + parent.width &&
    child.y + child.height <= parent.y + parent.height
}

async function responseBody(response: Response) {
  return await response.json().catch(() => null) as Record<string, unknown> | null
}

async function scope402Error(response: Response) {
  const body = await responseBody(response)
  return new Scope402HttpError(response.status, String(body?.error ?? 'UNKNOWN'),
    typeof body?.message === 'string' ? body.message : `Scope402 returned HTTP ${response.status}`)
}

abstract class TesseraAuthority {
  protected committedCounter = 0
  protected remainingCalls: number
  private readonly operations = new Map<string, PreparedOperation>()
  private pendingOperationId: string | undefined
  private operationQueue: Promise<void> = Promise.resolve()

  protected constructor(
    protected readonly requestUrl: string,
    protected readonly lease: CapabilityLease,
    protected readonly subject: AgentSubject,
    protected readonly request: Fetch,
  ) {
    this.remainingCalls = lease.max_calls
  }

  capability(): TesseraCapabilityView {
    return {
      lease_id: this.lease.lease_id,
      subject: subjectFingerprint(this.lease.subject_pubkey),
      resource: this.lease.resource,
      tool_ids: ['place_pixel'],
      max_calls: this.lease.max_calls,
      remaining_calls: this.remainingCalls,
      exp: this.lease.exp,
      root_lease_id: this.lease.root_lease_id,
      ...(this.lease.parent_lease_id ? { parent_lease_id: this.lease.parent_lease_id } : {}),
      payment_quote_id: this.lease.offer_id,
      hedera_tx_id: this.lease.hedera_tx_id,
      policy_hash: this.lease.policy_hash,
    }
  }

  async paint(args: { x: number; y: number; color: string },
    idempotencyKey = randomUUID()): Promise<TesseraPaintReceipt> {
    const fullArgs = { canvas_id: this.lease.resource.canvasId, ...args }
    return this.serialized(async () => {
      let prepared = this.operations.get(idempotencyKey)
      const requestHash = hash(fullArgs)
      if (prepared && prepared.requestHash !== requestHash) {
        throw new Error('Idempotency key was reused with different pixel arguments')
      }
      if (prepared?.state === 'denied') throw prepared.denial
      if (!prepared) {
        if (this.pendingOperationId) {
          throw new Error(`Recover pending pixel operation ${this.pendingOperationId} before starting another`)
        }
        const counter = this.committedCounter + 1
        const signed = invocation(this.lease.lease_id, fullArgs, counter)
        prepared = { counter, requestHash, requestBody: JSON.stringify({
          lease: this.lease.token,
          args: fullArgs,
          counter,
          signature: this.subject.sign(signed),
        }), state: 'pending' }
        this.operations.set(idempotencyKey, prepared)
        this.pendingOperationId = idempotencyKey
      }
      let response: Response
      try {
        response = await this.request(new URL('/v1/tools/place_pixel', this.requestUrl), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
          body: prepared.requestBody,
          redirect: 'error',
          signal: AbortSignal.timeout(20_000),
        })
      } catch (error) {
        throw new Error(`Pixel delivery is uncertain; retry operation ${idempotencyKey}`, { cause: error })
      }
      if (!response.ok) {
        const error = await scope402Error(response)
        if (response.status < 500) {
          prepared.state = 'denied'
          prepared.denial = error
          if (this.pendingOperationId === idempotencyKey) this.pendingOperationId = undefined
        }
        throw error
      }
      const value = await responseBody(response)
      const pixel = record(value?.pixel, 'Tessera returned no committed pixel')
      if (value?.status !== 'PIXEL_PLACED' || value.lease_id !== this.lease.lease_id ||
          value.counter !== prepared.counter || !Number.isSafeInteger(value.remaining_calls) ||
          Number(value.remaining_calls) < 0 || Number(value.remaining_calls) > this.lease.max_calls ||
          pixel.canvas_id !== fullArgs.canvas_id || pixel.x !== fullArgs.x ||
          pixel.y !== fullArgs.y || pixel.color !== fullArgs.color) {
        throw new Error('Tessera returned an invalid pixel receipt')
      }
      if (prepared.state !== 'committed') {
        this.committedCounter = prepared.counter
        this.remainingCalls = Math.min(this.remainingCalls, Number(value.remaining_calls))
        prepared.state = 'committed'
        if (this.pendingOperationId === idempotencyKey) this.pendingOperationId = undefined
      }
      return value as unknown as TesseraPaintReceipt
    })
  }

  protected serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation)
    this.operationQueue = result.then(() => undefined, () => undefined)
    return result
  }
}

export type TesseraDelegation = {
  worker: AgentSubject
  resource: CanvasRegion
  maxCalls: number
  expiresAt: number
  idempotencyKey?: string
}

export class TesseraWorkerAuthority extends TesseraAuthority {
  constructor(requestUrl: string, lease: DelegatedLease, worker: AgentSubject,
    request: Fetch = fetch) {
    super(requestUrl, lease, worker, request)
  }
}

export class TesseraRootAuthority extends TesseraAuthority {
  private committedDelegationCounter = 0
  private readonly delegations = new Map<string, PreparedOperation>()
  private pendingDelegationId: string | undefined
  private delegationQueue: Promise<void> = Promise.resolve()

  constructor(readonly prepared: PreparedPlot, readonly result: TesseraPlotResult,
    request: Fetch = fetch) {
    super(prepared.requestUrl, result.lease, prepared.subject, request)
  }

  delegate(input: TesseraDelegation): Promise<TesseraWorkerAuthority> {
    const run = async () => {
      const idempotencyKey = input.idempotencyKey ?? randomUUID()
      const now = Math.floor(Date.now() / 1_000)
      if (input.worker.subjectPubkey === this.lease.subject_pubkey) {
        throw new Error('Worker must use a distinct P-256 subject key')
      }
      if (!containsRegion(this.lease.resource, input.resource) ||
          exactRegion(this.lease.resource, input.resource)) {
        throw new Error('Worker region must be strictly contained by the root region')
      }
      if (!Number.isSafeInteger(input.maxCalls) || input.maxCalls < 1) {
        throw new Error('Worker call budget must be a positive integer')
      }
      if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now ||
          input.expiresAt > this.lease.exp) {
        throw new Error('Worker expiry must be active and no later than the root expiry')
      }
      const requestHash = hash({
        worker: input.worker.subjectPubkey,
        resource: input.resource,
        maxCalls: input.maxCalls,
        expiresAt: input.expiresAt,
      })
      let prepared = this.delegations.get(idempotencyKey)
      if (prepared && prepared.requestHash !== requestHash) {
        throw new Error('Idempotency key was reused with different delegation terms')
      }
      if (prepared?.state === 'denied') throw prepared.denial
      if (!prepared) {
        if (this.pendingDelegationId) {
          throw new Error(`Recover pending delegation ${this.pendingDelegationId} before starting another`)
        }
        const counter = this.committedDelegationCounter + 1
        const terms = {
          parent_lease_id: this.lease.lease_id,
          child_subject_pubkey: input.worker.subjectPubkey,
          resource: input.resource,
          tool_ids: ['place_pixel'],
          max_calls: input.maxCalls,
          expires_at: input.expiresAt,
          counter,
          issued_at: now,
        }
        prepared = { counter, requestHash, requestBody: JSON.stringify({
          lease: this.lease.token,
          delegation: this.subject.signDelegation(terms),
        }), state: 'pending' }
        this.delegations.set(idempotencyKey, prepared)
        this.pendingDelegationId = idempotencyKey
      }
      let response: Response
      try {
        response = await this.request(new URL(
          `/v1/leases/${this.lease.lease_id}/delegations`, this.requestUrl), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
          body: prepared.requestBody,
          redirect: 'error',
          signal: AbortSignal.timeout(20_000),
        })
      } catch (error) {
        throw new Error(`Delegation delivery is uncertain; retry operation ${idempotencyKey}`, { cause: error })
      }
      if (!response.ok) {
        const error = await scope402Error(response)
        if (response.status < 500) {
          prepared.state = 'denied'
          prepared.denial = error
          if (this.pendingDelegationId === idempotencyKey) this.pendingDelegationId = undefined
        }
        throw error
      }
      const value = await responseBody(response)
      const lease = record(value?.lease, 'Tessera returned no delegated capability')
      const parent = record(value?.parent, 'Tessera returned no parent budget state')
      if (value?.status !== 'CAPABILITY_DELEGATED' || typeof lease.token !== 'string' ||
          typeof lease.lease_id !== 'string' || lease.subject_pubkey !== input.worker.subjectPubkey ||
          lease.parent_lease_id !== this.lease.lease_id ||
          lease.root_lease_id !== this.lease.root_lease_id ||
          lease.offer_id !== this.lease.offer_id || lease.hedera_tx_id !== this.lease.hedera_tx_id ||
          lease.aud !== this.lease.aud || lease.max_calls !== input.maxCalls ||
          lease.exp !== input.expiresAt || !exactRegion(lease.resource, input.resource) ||
          !Array.isArray(lease.tool_ids) || lease.tool_ids.length !== 1 ||
          lease.tool_ids[0] !== 'place_pixel' || typeof lease.policy_hash !== 'string' ||
          parent.lease_id !== this.lease.lease_id ||
          parent.delegation_counter !== prepared.counter ||
          !Number.isSafeInteger(parent.remaining_calls) || Number(parent.remaining_calls) < 0 ||
          Number(parent.remaining_calls) > this.lease.max_calls) {
        throw new Error('Tessera returned an invalid delegated capability')
      }
      if (prepared.state !== 'committed') {
        this.committedDelegationCounter = prepared.counter
        this.remainingCalls = Math.min(this.remainingCalls, Number(parent.remaining_calls))
        prepared.state = 'committed'
        if (this.pendingDelegationId === idempotencyKey) this.pendingDelegationId = undefined
      }
      return new TesseraWorkerAuthority(this.requestUrl,
        lease as unknown as DelegatedLease, input.worker, this.request)
    }
    const result = this.delegationQueue.then(run, run)
    this.delegationQueue = result.then(() => undefined, () => undefined)
    return result
  }
}

export class Scope402Client {
  constructor(readonly config: Scope402ClientConfig, private readonly request: Fetch = fetch) {}

  private paymentPolicy(): AgentPolicy {
    const { auditLabUrl, payer, merchant, maxPaymentTinybars } = this.config
    if (!payer || !merchant || !maxPaymentTinybars) {
      throw new Error('Configure payer, merchant, and maxPaymentTinybars before preparing paid work')
    }
    return { auditLabUrl, payer, merchant, maxPaymentTinybars }
  }

  createSubject() {
    return ephemeralSubject()
  }

  persistentSubject() {
    return persistentSubject()
  }

  async listTesseraWorlds() {
    const response = await this.request(new URL('/v1/canvases', this.config.auditLabUrl), {
      headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw await scope402Error(response)
    const value = await response.json().catch(() => null) as unknown
    const catalogue = record(value, 'Tessera returned an invalid world catalogue')
    if (!Array.isArray(catalogue.canvases)) throw new Error('Tessera returned an invalid world catalogue')
    return catalogue.canvases.map(assertWorldSummary)
  }

  async readTesseraWorld(requestedCanvasId = 'main') {
    if (!canvasId(requestedCanvasId)) throw new Error('Tessera canvas ID is invalid')
    const path = requestedCanvasId === 'main' ? '/v1/canvas' :
      `/v1/canvas/${encodeURIComponent(requestedCanvasId)}`
    const response = await this.request(new URL(path, this.config.auditLabUrl), {
      headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw await scope402Error(response)
    const value = await response.json().catch(() => null) as unknown
    return assertWorldState(value, requestedCanvasId)
  }

  async *watchTesseraWorld(requestedCanvasId = 'main', signal?: AbortSignal) {
    if (!canvasId(requestedCanvasId)) throw new Error('Tessera canvas ID is invalid')
    const path = requestedCanvasId === 'main' ? '/v1/canvas/events' :
      `/v1/canvas/${encodeURIComponent(requestedCanvasId)}/events`
    const response = await this.request(new URL(path, this.config.auditLabUrl), {
      headers: { Accept: 'text/event-stream' }, redirect: 'error', signal,
    })
    if (!response.ok) throw await scope402Error(response)
    for await (const message of serverSentEvents(response)) {
      if (message.event === 'heartbeat') continue
      if (message.event === 'error') throw new Error('Tessera world event stream reported an error')
      if (message.event !== 'world') continue
      const value = message.data ? JSON.parse(message.data) as unknown : null
      yield assertWorldState(value, requestedCanvasId)
    }
  }

  prepareTessera(input: { subject: AgentSubject; canvasId?: string; slot?: number;
    location?: { latitude: number; longitude: number } }) {
    return preparePlotPurchase(this.paymentPolicy(), input.subject, this.request,
      input.slot, input.canvasId ?? 'main', input.location)
  }

  async approveTessera(prepared: PreparedPlot, payerPrivateKey: string) {
    const settled = await approvePlotPurchase({ ...this.paymentPolicy(), payerPrivateKey }, prepared, this.request)
    return { ...settled, authority: new TesseraRootAuthority(prepared, settled.result, this.request) }
  }

  prepareAuditLab(input: { subject: AgentSubject; repository: string }) {
    return prepareScanPurchase(this.paymentPolicy(), input.repository, input.subject, this.request)
  }

  approveAuditLab(prepared: PreparedScan, payerPrivateKey: string) {
    return approveScanPurchase({ ...this.paymentPolicy(), payerPrivateKey }, prepared, this.request)
  }
}
