export type DemoRun = {
  run_id: string
  state: 'PAYMENT_REQUIRED' | 'SETTLING' | 'COMPLETE' | 'FAILED'
  created_at: string
  expires_at: string
  mode: 'hosted-testnet-agent'
  quote: {
    repository: string
    commit_sha: string
    pricing: {
      base_tinybars: string
      per_file_tinybars: string
      file_cap: number
      files_considered: number
      files_charged: number
      total_tinybars: string
    }
    payer: string
    merchant: string
    network: 'hedera:testnet'
    asset: '0.0.0'
  }
  result?: {
    scan_id: string
    findings: Array<{ id: string; severity: string; message: string }>
    payment: {
      payer: string
      merchant: string
      amount_tinybars: string
      transaction: string
      hashscan_url: string
    }
    lease: {
      lease_id: string
      subject_pubkey: string
      aud: string
      tool_ids: string[]
      max_calls: number
      remaining_calls: number
      exp: number
      hedera_tx_id: string
      scan_id: string
    }
  }
  actions?: Partial<Record<DemoActionName, DemoActionResult>>
  error?: { code: string; message: string }
}

export type DemoActionName = 'wrong-key' | 'legitimate' | 'replay' | 'expire'

export type DemoActionResult = {
  action: DemoActionName
  verdict: 'ALLOWED' | 'DENIED'
  status: 200 | 403 | 410
  code: 'FINDING_DETAILS_ALLOWED' | 'SUBJECT_KEY_MISMATCH' | 'REPLAY_DETECTED' | 'LEASE_EXPIRED'
  message: string
  counter: number
  remaining_calls: number
  finding?: { id: string; severity: string; message: string }
}

type PreparedRun = { run: DemoRun; run_token: string }

const demoAgentBase = import.meta.env.VITE_DEMO_AGENT_URL || '/demo-agent'

function endpoint(path: string) {
  return demoAgentBase.startsWith('http') ? new URL(path, demoAgentBase).href : `${demoAgentBase}${path}`
}

async function readResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as T | null
  if (!response.ok) {
    const errorBody = body && typeof body === 'object' ? body as Record<string, unknown> : {}
    const code = typeof errorBody.error === 'string' ? errorBody.error : `HTTP_${response.status}`
    const message = typeof errorBody.message === 'string'
      ? errorBody.message : 'The hosted Demo Agent request failed'
    throw new Error(`${code}: ${message}`)
  }
  return body as T
}

export async function prepareDemoRun(repoUrl: string) {
  const response = await fetch(endpoint('/demo/runs'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo_url: repoUrl }), signal: AbortSignal.timeout(45_000),
  })
  return readResponse<PreparedRun>(response)
}

export async function approveDemoRun(runId: string, token: string) {
  const response = await fetch(endpoint(`/demo/runs/${runId}/approve`), {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}', signal: AbortSignal.timeout(120_000),
  })
  return readResponse<DemoRun>(response)
}

export async function getDemoRun(runId: string, token: string) {
  const response = await fetch(endpoint(`/demo/runs/${runId}`), {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000),
  })
  return readResponse<DemoRun>(response)
}

export async function executeDemoAction(runId: string, token: string, action: DemoActionName) {
  const response = await fetch(endpoint(`/demo/runs/${runId}/actions/${action}`), {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}', signal: AbortSignal.timeout(30_000),
  })
  return readResponse<DemoActionResult>(response)
}

export const publicDemoAgentUrl = 'https://scope402-demo-agent.onrender.com'
