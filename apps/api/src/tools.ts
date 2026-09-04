import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { authorizeInvocation, hashArgs, verifyInvocation, verifyServiceLease, type Invocation } from './leases.js'
import { LeaseError } from './lease-error.js'

type ToolRequest = { lease: string; args: { finding_id: string }; counter: number; signature: string }

function parseRequest(value: unknown): ToolRequest {
  const body = value as Partial<ToolRequest>
  if (!body || typeof body !== 'object' || typeof body.lease !== 'string' ||
      typeof body.signature !== 'string' || !Number.isSafeInteger(body.counter) || Number(body.counter) < 1 ||
      !body.args || typeof body.args.finding_id !== 'string') throw new LeaseError('LEASE_REQUIRED', 'Invalid tool request')
  return body as ToolRequest
}

export const tools = new Hono()
tools.use('*', bodyLimit({ maxSize: 32_768 }))
tools.post('/finding_details', async (c) => {
  try {
    const request = parseRequest(await c.req.json())
    const claims = await verifyServiceLease(request.lease)
    if (claims.exp <= Math.floor(Date.now() / 1000)) throw new LeaseError('LEASE_EXPIRED', 'Lease has expired')
    if (!claims.tool_ids.includes('finding_details')) throw new LeaseError('TOOL_NOT_ALLOWED', 'Tool is not in this lease')
    const invocation: Invocation = verifyInvocation(request.signature, claims.subject_pubkey)
    if (invocation.lease_id !== claims.lease_id) throw new LeaseError('LEASE_REQUIRED', 'Invocation is for another lease')
    if (invocation.tool_id !== 'finding_details') throw new LeaseError('TOOL_NOT_ALLOWED', 'Invocation is for another tool')
    if (invocation.args_hash !== hashArgs(request.args)) {
      throw new LeaseError('ARGUMENT_HASH_MISMATCH', 'Signed arguments do not match the request')
    }
    if (invocation.counter !== request.counter) throw new LeaseError('REPLAY_DETECTED', 'Signed counter does not match')
    if (!Number.isSafeInteger(invocation.issued_at) || Math.abs(Date.now() / 1000 - invocation.issued_at) > 120) {
      throw new LeaseError('LEASE_REQUIRED', 'Invocation timestamp is invalid')
    }
    const findings = await authorizeInvocation(claims, invocation, request.args.finding_id)
    const finding = findings.find((value) => (value as Record<string, unknown>)?.id === request.args.finding_id)
    if (!finding) return c.json({ error: 'FINDING_NOT_FOUND', message: 'Finding does not exist in this scan' }, 404)
    return c.json({ lease_id: claims.lease_id, counter: request.counter, finding })
  } catch (error) {
    if (error instanceof LeaseError) {
      const status = error.code === 'LEASE_EXPIRED' ? 410 : error.code === 'FINDING_NOT_FOUND' ? 404 :
        error.code === 'LEASE_REQUIRED' ? 401 : 403
      return c.json({ error: error.code, message: error.message }, status)
    }
    return c.json({ error: 'LEASE_REQUIRED', message: 'Invalid signed invocation' }, 401)
  }
})
