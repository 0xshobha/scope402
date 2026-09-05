export type Discovery = {
  service: { id: string; name: string }
  version: number
  network: string
  payment: { protocol: string; version: number; facilitator: string }
  resources: { repository_scan: { method: string; path: string } }
  authorization: { scheme: string; tools: Array<{ id: string; method: string; path: string }> }
}

export type LiveState = {
  state: 'online' | 'waking' | 'offline'
  discovery?: Discovery
  latencyMs?: number
}

const apiBase = import.meta.env.VITE_AUDITLAB_URL || '/auditlab'

function endpoint(path: string) {
  return apiBase.startsWith('http') ? new URL(path, apiBase).href : `${apiBase}${path}`
}

export async function loadLiveState(): Promise<LiveState> {
  const started = performance.now()
  try {
    const [health, discovery] = await Promise.all([
      fetch(endpoint('/health'), { signal: AbortSignal.timeout(35_000) }),
      fetch(endpoint('/.well-known/scope402'), { signal: AbortSignal.timeout(35_000) }),
    ])
    if (!health.ok || !discovery.ok) throw new Error('AuditLab is unavailable')
    const healthBody = await health.json() as { ok?: unknown; service?: unknown }
    const contract = await discovery.json() as Discovery
    if (healthBody.ok !== true || healthBody.service !== 'auditlab' ||
        contract.service?.id !== 'auditlab' || contract.resources?.repository_scan?.method !== 'POST') {
      throw new Error('AuditLab returned an incompatible contract')
    }
    return { state: 'online', discovery: contract,
      latencyMs: Math.round(performance.now() - started) }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') return { state: 'waking' }
    return { state: 'offline' }
  }
}

export const publicApiUrl = 'https://scope402-auditlab.onrender.com'
