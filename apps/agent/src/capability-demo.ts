import { createHash } from 'node:crypto'
import { canonicalJson } from './canonical.js'
import type { PreparedScan, ScanResult } from './purchase.js'
import { attackerSubject } from './subject.js'

export type DemoActionName = 'wrong-key' | 'legitimate' | 'replay' | 'expire'

export type DemoActionResult = {
  action: DemoActionName
  verdict: 'ALLOWED' | 'DENIED'
  status: 200 | 403 | 410
  code: 'FINDING_DETAILS_ALLOWED' | 'SUBJECT_KEY_MISMATCH' | 'REPLAY_DETECTED' | 'LEASE_EXPIRED'
  message: string
  counter: number
  remaining_calls: number
  finding?: ScanResult['findings'][number]
}

export type DemoCapabilitySession = {
  execute(action: DemoActionName): Promise<DemoActionResult>
}

type ErrorBody = { error?: unknown; message?: unknown }

async function responseBody(response: Response) {
  return await response.json().catch(() => null) as ErrorBody | Record<string, unknown> | null
}

function invocation(result: ScanResult, findingId: string, counter: number) {
  const args = { finding_id: findingId }
  return {
    args,
    claims: {
      lease_id: result.lease.lease_id,
      tool_id: 'finding_details' as const,
      counter,
      args_hash: createHash('sha256').update(canonicalJson(args)).digest('hex'),
      issued_at: Math.floor(Date.now() / 1_000),
    },
  }
}

function requestBody(result: ScanResult, data: ReturnType<typeof invocation>, signature: string) {
  return JSON.stringify({
    lease: result.lease.token,
    args: data.args,
    counter: data.claims.counter,
    signature,
  })
}

async function requireDenial(response: Response, action: DemoActionName, counter: number,
  status: 403 | 410, code: DemoActionResult['code'], remainingCalls: number): Promise<DemoActionResult> {
  const body = await responseBody(response)
  const actualCode = body && 'error' in body ? String(body.error) : 'UNKNOWN'
  if (response.status !== status || actualCode !== code) {
    throw new Error(`Expected HTTP ${status} ${code}; AuditLab returned HTTP ${response.status} ${actualCode}`)
  }
  return {
    action,
    verdict: 'DENIED',
    status,
    code,
    message: body && 'message' in body && typeof body.message === 'string' ? body.message : code,
    counter,
    remaining_calls: remainingCalls,
  }
}

export function createCapabilitySession(prepared: PreparedScan, result: ScanResult,
  demoControlSecret: string, request: typeof fetch = fetch): DemoCapabilitySession {
  const finding = result.findings[0]
  if (!finding) throw new Error('A capability demo requires a real scan finding')
  const toolUrl = new URL('/v1/tools/finding_details', prepared.requestUrl)
  const expireUrl = new URL(`/v1/leases/${result.lease.lease_id}/expire`, prepared.requestUrl)
  let legitimateBody: string | undefined

  const call = (body: string) => request(toolUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  })

  return {
    async execute(action) {
      if (action === 'wrong-key') {
        const data = invocation(result, finding.id, 1)
        const body = requestBody(result, data, attackerSubject().sign(data.claims))
        return requireDenial(await call(body), action, 1, 403, 'SUBJECT_KEY_MISMATCH', 3)
      }

      if (action === 'legitimate') {
        const data = invocation(result, finding.id, 1)
        legitimateBody = requestBody(result, data, prepared.subject.sign(data.claims))
        const response = await call(legitimateBody)
        const body = await responseBody(response)
        if (response.status !== 200 || !body || !('finding' in body)) {
          const code = body && 'error' in body ? String(body.error) : 'UNKNOWN'
          throw new Error(`Expected an allowed tool call; AuditLab returned HTTP ${response.status} ${code}`)
        }
        return {
          action,
          verdict: 'ALLOWED',
          status: 200,
          code: 'FINDING_DETAILS_ALLOWED',
          message: 'The declared subject key used one leased call.',
          counter: 1,
          remaining_calls: 2,
          finding,
        }
      }

      if (action === 'replay') {
        if (!legitimateBody) throw new Error('Run the legitimate invocation before replaying it')
        return requireDenial(await call(legitimateBody), action, 1, 403, 'REPLAY_DETECTED', 2)
      }

      if (!demoControlSecret || demoControlSecret.length < 32) {
        throw new Error('Demo expiry control is not configured')
      }
      const expired = await request(expireUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${demoControlSecret}` },
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      })
      if (!expired.ok) {
        throw new Error(expired.status === 404 ? 'Demo controls are disabled on AuditLab' :
          `AuditLab expiry control returned HTTP ${expired.status}`)
      }
      const data = invocation(result, finding.id, 2)
      const body = requestBody(result, data, prepared.subject.sign(data.claims))
      return requireDenial(await call(body), action, 2, 410, 'LEASE_EXPIRED', 2)
    },
  }
}
