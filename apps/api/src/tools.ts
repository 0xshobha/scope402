import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { authorizeInvocation, verifyServiceLease } from './leases.js'
import { LeaseError } from './lease-error.js'
import { verifyBoundInvocation } from './scope402/invocation.js'

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
    const invocation = verifyBoundInvocation({ signature: request.signature, claims,
      counter: request.counter, args: request.args, toolId: 'finding_details' })
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
