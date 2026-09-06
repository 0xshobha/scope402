export type Discovery = {
  service: { id: string; name: string }
  version: number
  network: string
  payment: { protocol: string; version: number; facilitator: string }
  resources: { repository_scan: { method: string; path: string } }
  authorization: { scheme: string; tools: Array<{ id: string; method: string; path: string }> }
}

export type LiveState = {
  state: 'online' | 'waking' | 'offline' | 'degraded'
  health: 'online' | 'unavailable'
  contract: 'online' | 'unavailable' | 'incompatible'
  discovery?: Discovery
  latencyMs?: number
  message?: string
}

export const publicApiUrl = 'https://scope402-auditlab.onrender.com'
const apiBase = import.meta.env.VITE_AUDITLAB_URL || (import.meta.env.DEV ? '/auditlab' : publicApiUrl)

function endpoint(path: string) {
  return apiBase.startsWith('http') ? new URL(path, apiBase).href : `${apiBase}${path}`
}

export async function loadLiveState(): Promise<LiveState> {
  const started = performance.now()
  const [healthResult, discoveryResult] = await Promise.allSettled([
    fetch(endpoint('/health'), { signal: AbortSignal.timeout(10_000) }),
    fetch(endpoint('/.well-known/scope402'), { signal: AbortSignal.timeout(10_000) }),
  ])
  let health: LiveState['health'] = 'unavailable'
  let contractState: LiveState['contract'] = 'unavailable'
  let discovery: Discovery | undefined
  let timedOut = false
  if (healthResult.status === 'fulfilled' && healthResult.value.ok) {
    const value = await healthResult.value.json().catch(() => null) as { ok?: unknown; service?: unknown } | null
    if (value?.ok === true && value.service === 'auditlab') health = 'online'
  } else if (healthResult.status === 'rejected' && healthResult.reason instanceof DOMException &&
      healthResult.reason.name === 'TimeoutError') timedOut = true
  if (discoveryResult.status === 'fulfilled' && discoveryResult.value.ok) {
    const value = await discoveryResult.value.json().catch(() => null) as Discovery | null
    if (value?.service?.id === 'auditlab' && value.resources?.repository_scan?.method === 'POST' &&
        value.authorization?.tools?.some((tool) => tool.id === 'finding_details')) {
      discovery = value
      contractState = 'online'
    } else contractState = 'incompatible'
  } else if (discoveryResult.status === 'rejected' && discoveryResult.reason instanceof DOMException &&
      discoveryResult.reason.name === 'TimeoutError') timedOut = true
  const latencyMs = Math.round(performance.now() - started)
  if (health === 'online' && contractState === 'online') {
    return { state: 'online', health, contract: contractState, discovery, latencyMs }
  }
  if (health === 'online' || contractState === 'online') {
    return { state: 'degraded', health, contract: contractState, discovery, latencyMs,
      message: health === 'online' ? 'API online; discovery unavailable' : 'Discovery online; health unavailable' }
  }
  return { state: timedOut ? 'waking' : 'offline', health, contract: contractState, latencyMs,
    message: timedOut ? 'Service may be waking; retrying automatically' : 'Network or local proxy unavailable' }
}
