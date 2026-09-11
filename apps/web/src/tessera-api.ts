export type TesseraState =
  | 'PAYMENT_REQUIRED'
  | 'PAYMENT_RECOVERY'
  | 'SETTLING'
  | 'ROOT_ACTIVE'
  | 'ACTION_PENDING'
  | 'CHILD_ACTIVE'
  | 'MISSION_RUNNING'
  | 'MISSION_COMPLETE'
  | 'COMPLETE'
  | 'FAILED'

export type CanvasRegion = {
  kind: 'canvas-region'
  canvasId: string
  x: number
  y: number
  width: number
  height: number
}
export type TesseraLocation = { latitude: number; longitude: number }

export type TesseraCapability = {
  lease_id: string
  subject: string
  resource: CanvasRegion
  tool_ids: string[]
  max_calls: number
  remaining_calls: number
  exp: number
  root_lease_id: string
  parent_lease_id?: string
  payment_quote_id: string
  hedera_tx_id: string
  policy_hash: string
}

export type TesseraRun = {
  run_id: string
  state: TesseraState
  created_at: string
  expires_at: string
  mode: 'hosted-testnet-agent'
  quote?: {
    canvas_id: string
    location: TesseraLocation
    region: CanvasRegion
    pricing: {
      base_tinybars: string
      per_call_tinybars: string
      calls: number
      total_tinybars: string
    }
    policy_hash: string
    payer: string
    merchant: string
    network: string
    asset: string
  }
  payment?: {
    payer: string
    merchant: string
    amount_tinybars: string
    transaction: string
    hashscan_url: string
  }
  root?: TesseraCapability
  child?: TesseraCapability
  actions: TesseraActionResult[]
  paint_events: TesseraPaintResult[]
  mission: {
    id: 'signal-spark'
    goal: string
    state: 'PLANNED' | 'RUNNING' | 'COMPLETE'
    plan: { rootRegion: CanvasRegion; workerRegion: CanvasRegion; requiredCalls: number;
      delegatedCalls: number; boundaryProbe: { x: number; y: number; color: string } }
    events: Array<{ sequence: number; at: string; stage: string;
      actor: 'principal' | 'worker' | 'system'; verdict: string; code: string; message: string;
      pixel?: { x: number; y: number; color: string }; remaining_calls?: number }>
    receipt?: { payment_transaction: string; policy_hash: string; root_lease_id: string;
      worker_lease_id: string; pixels_placed: number;
      denied_actions: Array<{ actor: 'worker'; code: 'OUT_OF_SCOPE';
        pixel: { x: number; y: number; color: string } }> }
  }
  last_action?: TesseraActionResult
  error?: { code: string; message: string }
}

export type TesseraPaintResult = {
  request_id: string
  status: 200
  code: 'PIXEL_PLACED'
  remaining_calls: number
  pixel: { canvas_id: string; x: number; y: number; color: string; updated_at: number }
}

export type TesseraCanvas = {
  canvas_id: string
  location: TesseraLocation
  width: 32
  height: 32
  palette: string[]
  world: { name: string; painted_pixels: number; total_placements: number; total_pixels: number;
    completion_percent: number; current_painters: number;
    active_territories: number; reserved_territories: number }
  pixels: Array<{ x: number; y: number; color: string; updated_at: number; agent?: string }>
  leaderboard: Array<{ agent: string; placements: number; current_pixels: number; last_active: number }>
  recent_activity: Array<{ x: number; y: number; color: string; counter: number;
    painted_at: number; agent: string }>
  reservations: Array<CanvasRegion & { slot: number; agent: string; expires_at: number;
    status: 'reserved' }>
  regions: Array<{
    slot: number
    kind: 'canvas-region'
    canvasId: string
    x: number
    y: number
    width: number
    height: number
    lease_id: string
    agent?: string
    expires_at: number
    remaining_calls: number
    active: boolean
    status: 'active' | 'expired'
  }>
}

export type TesseraCanvasSummary = {
  canvas_id: string
  name: string
  width: number
  height: number
  created_at: number
  painted_pixels: number
  claimed_territories: number
  location: TesseraLocation
}

export type TesseraActionName =
  | 'delegate'
  | 'place-outside'
  | 'wrong-key'
  | 'place-inside'
  | 'replay'
  | 'expire'

export type TesseraActionResult = {
  action: TesseraActionName
  sequence: number
  at: string
  verdict: 'ALLOWED' | 'DENIED'
  status: number
  code: string
  message: string
  remaining_calls?: number
  pixel?: { canvas_id: string; x: number; y: number; color: string; updated_at: number }
}

export const publicTesseraAgentUrl =
  import.meta.env.VITE_TESSERA_AGENT_URL || 'https://scope402-demo-agent.onrender.com'
export const publicTesseraApiUrl =
  import.meta.env.VITE_TESSERA_API_URL || 'https://scope402-auditlab.onrender.com'
const agentBase = import.meta.env.VITE_TESSERA_AGENT_URL || import.meta.env.VITE_DEMO_AGENT_URL ||
  (import.meta.env.DEV ? '/demo-agent' : publicTesseraAgentUrl)
const apiBase = import.meta.env.VITE_TESSERA_API_URL || (import.meta.env.DEV ? '/auditlab' : publicTesseraApiUrl)
type PreparedRun = { run: TesseraRun; run_token: string }

function endpoint(base: string, path: string) {
  return base.startsWith('http') ? new URL(path, base).href : `${base}${path}`
}

async function readResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as T | { error?: unknown; message?: unknown } | null
  if (!response.ok) {
    const errorBody = body && typeof body === 'object' ? body as { error?: unknown; message?: unknown } : {}
    const missingRevision = response.status === 404 && typeof errorBody.error !== 'string'
    const code = missingRevision ? 'TESSERA_AGENT_REVISION_UNAVAILABLE' :
      typeof errorBody.error === 'string' ? errorBody.error : `HTTP_${response.status}`
    const message = missingRevision ?
      'The hosted agent is online, but its deployed revision does not include Tessera yet.' :
      typeof errorBody.message === 'string' ? errorBody.message : 'The hosted Tessera agent request failed'
    throw new Error(`${code}: ${message}`)
  }
  return body as T
}

function assertRun(value: TesseraRun): TesseraRun {
  if (!value || typeof value !== 'object' || typeof value.run_id !== 'string' ||
      typeof value.state !== 'string' || !['PAYMENT_REQUIRED', 'PAYMENT_RECOVERY', 'SETTLING', 'ROOT_ACTIVE',
        'CHILD_ACTIVE', 'ACTION_PENDING', 'MISSION_RUNNING', 'MISSION_COMPLETE', 'COMPLETE', 'FAILED'].includes(value.state) ||
      !Array.isArray(value.actions) || !value.mission || !Array.isArray(value.mission.events)) {
    throw new Error('Hosted Tessera agent returned an invalid run')
  }
  return { ...value, paint_events: Array.isArray(value.paint_events) ? value.paint_events : [] }
}

export async function createTesseraRun(slot?: number, canvasId = 'main', location?: TesseraLocation) {
  const response = await fetch(endpoint(agentBase, '/tessera/runs'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(canvasId === 'main' ? {} : { canvas_id: canvasId }),
      ...(slot === undefined ? {} : { slot }), ...(location === undefined ? {} : { location }) }),
    signal: AbortSignal.timeout(30_000),
  })
  const prepared = await readResponse<PreparedRun>(response)
  return { ...prepared, run: assertRun(prepared.run) }
}

export async function getTesseraRun(runId: string, token: string) {
  const response = await fetch(endpoint(agentBase, `/tessera/runs/${encodeURIComponent(runId)}`), {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
  })
  return assertRun(await readResponse<TesseraRun>(response))
}

export async function approveTesseraRun(runId: string, token: string) {
  const response = await fetch(endpoint(agentBase,
    `/tessera/runs/${encodeURIComponent(runId)}/approve`), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: '{}', signal: AbortSignal.timeout(120_000),
  })
  return assertRun(await readResponse<TesseraRun>(response))
}

export async function runTesseraMission(runId: string, token: string) {
  const response = await fetch(endpoint(agentBase,
    `/tessera/runs/${encodeURIComponent(runId)}/mission`), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: '{}', signal: AbortSignal.timeout(120_000),
  })
  return assertRun(await readResponse<TesseraRun>(response))
}

export async function executeTesseraAction(runId: string, token: string, action: TesseraActionName) {
  const response = await fetch(endpoint(agentBase,
    `/tessera/runs/${encodeURIComponent(runId)}/actions/${action}`), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}',
    signal: AbortSignal.timeout(120_000),
  })
  return readResponse<TesseraActionResult>(response)
}

export async function paintTesseraPixel(runId: string, token: string,
  input: { request_id: string; x: number; y: number; color: string }) {
  const response = await fetch(endpoint(agentBase,
    `/tessera/runs/${encodeURIComponent(runId)}/paint`), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(input), signal: AbortSignal.timeout(30_000),
  })
  return readResponse<TesseraPaintResult>(response)
}

export async function getTesseraAgentHealth() {
  const response = await fetch(endpoint(agentBase, '/health'), { cache: 'no-store',
    signal: AbortSignal.timeout(10_000) })
  const health = await readResponse<{ ok: true; service: string;
    features?: { tessera?: boolean; tessera_worlds?: boolean; tessera_missions?: boolean };
    contracts?: { tessera_runs?: number } }>(response)
  if (health.features?.tessera_worlds !== true || health.features?.tessera_missions !== true ||
      health.contracts?.tessera_runs !== 4) {
    throw new Error('TESSERA_AGENT_REVISION_UNAVAILABLE: The hosted agent is online, but it does not support autonomous world missions yet.')
  }
  return health
}

export async function getTesseraCanvas(canvasId = 'main') {
  const path = canvasId === 'main' ? '/v1/canvas' : `/v1/canvas/${encodeURIComponent(canvasId)}`
  const response = await fetch(endpoint(apiBase, path), {
    cache: 'no-store', signal: AbortSignal.timeout(15_000),
  })
  return normalizeTesseraCanvas(await readResponse<TesseraCanvas>(response))
}

function normalizeTesseraCanvas(canvas: TesseraCanvas) {
  const painted = Array.isArray(canvas.pixels) ? canvas.pixels.length : 0
  const world = canvas.world
  return { ...canvas, location: canvas.location ?? { latitude: 19.076, longitude: 72.8777 },
    world: { name: world?.name ?? 'Opal World',
      painted_pixels: world?.painted_pixels ?? painted,
      total_placements: world?.total_placements ?? painted,
      total_pixels: canvas.width * canvas.height,
      completion_percent: world?.completion_percent ??
        Number(((painted / (canvas.width * canvas.height)) * 100).toFixed(2)),
      current_painters: world?.current_painters ?? 0,
      active_territories: world?.active_territories ?? 0,
      reserved_territories: world?.reserved_territories ?? 0 },
    leaderboard: Array.isArray(canvas.leaderboard) ? canvas.leaderboard : [],
    recent_activity: Array.isArray(canvas.recent_activity) ? canvas.recent_activity : [],
    reservations: Array.isArray(canvas.reservations) ? canvas.reservations : [] }
}

export function subscribeTesseraCanvas(canvasId: string, handlers: {
  onCanvas(canvas: TesseraCanvas): void
  onStatus(status: 'CONNECTING' | 'LIVE' | 'RECONNECTING'): void
}) {
  const path = canvasId === 'main' ? '/v1/canvas/events' :
    `/v1/canvas/${encodeURIComponent(canvasId)}/events`
  const source = new EventSource(endpoint(apiBase, path))
  handlers.onStatus('CONNECTING')
  source.addEventListener('open', () => handlers.onStatus('LIVE'))
  source.addEventListener('world', (event) => {
    try {
      const canvas = JSON.parse((event as MessageEvent<string>).data) as TesseraCanvas
      if (canvas.canvas_id !== canvasId || canvas.width !== 32 || canvas.height !== 32 ||
          !Array.isArray(canvas.pixels) || !Array.isArray(canvas.regions)) return
      handlers.onCanvas(normalizeTesseraCanvas(canvas))
      handlers.onStatus('LIVE')
    } catch { /* EventSource reconnect and fallback polling preserve the last valid world. */ }
  })
  source.addEventListener('error', () => handlers.onStatus('RECONNECTING'))
  return () => source.close()
}

export async function getTesseraCanvases() {
  const response = await fetch(endpoint(apiBase, '/v1/canvases'), {
    cache: 'no-store', signal: AbortSignal.timeout(15_000),
  })
  const value = await readResponse<{ canvases: TesseraCanvasSummary[] }>(response)
  return Array.isArray(value.canvases) ? value.canvases.map((canvas) => ({ ...canvas,
    location: canvas.location ?? { latitude: 19.076, longitude: 72.8777 } })) : []
}
