import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { LeaseError } from './lease-error.js'
import { delegateCapability, verifyDelegation } from './scope402/delegation.js'
import { hasExactKeys } from './scope402/policy.js'
import { loadServiceKey, verifyLease } from './scope402/lease.js'
import { containsCanvasRegion, parseCanvasRegion } from './merchants/tessera/resource.js'
import { TESSERA_MERCHANT_ID } from './merchants/tessera/quotes.js'
import { exactPolicyEcho } from './scope402/policy.js'
import { operationReceipt, readOperationReceipt,
  type OperationReceipt } from './scope402/operation-receipts.js'

type DelegationRequest = { lease: string; delegation: string }

function parseRequest(value: unknown): DelegationRequest {
  if (!hasExactKeys(value, ['lease', 'delegation'])) {
    throw new LeaseError('LEASE_REQUIRED', 'Invalid delegation request')
  }
  const request = value as Partial<DelegationRequest>
  if (typeof request.lease !== 'string' || typeof request.delegation !== 'string') {
    throw new LeaseError('LEASE_REQUIRED', 'Invalid delegation request')
  }
  return request as DelegationRequest
}

export const delegations = new Hono()
delegations.use('*', bodyLimit({ maxSize: 32_768 }))
delegations.post('/:leaseId/delegations', async (c) => {
  let operation: OperationReceipt | undefined
  try {
    const request = parseRequest(await c.req.json())
    operation = operationReceipt(c.req.header('Idempotency-Key'),
      'delegate_capability', { leaseId: c.req.param('leaseId'), request })
    const recovered = await readOperationReceipt(operation)
    if (recovered) return c.json(recovered)
    const claims = verifyLease(request.lease, await loadServiceKey())
    if (claims.lease_id !== c.req.param('leaseId')) {
      throw new LeaseError('LEASE_REQUIRED', 'Parent lease does not match the route')
    }
    const terms = verifyDelegation(request.delegation, claims.subject_pubkey)
    return c.json(await delegateCapability(claims, terms, {
      merchantId: TESSERA_MERCHANT_ID,
      operation,
      authorizeResource(parent, child) {
        let parentRegion
        let childRegion
        try {
          parentRegion = parseCanvasRegion(parent)
          childRegion = parseCanvasRegion(child)
        } catch {
          throw new LeaseError('CAPABILITY_ESCALATION_DENIED', 'Child resource is invalid')
        }
        if (!containsCanvasRegion(parentRegion, childRegion) ||
            exactPolicyEcho(parentRegion, childRegion)) {
          throw new LeaseError('CAPABILITY_ESCALATION_DENIED',
            'Child resource must be strictly narrower than parent authority')
        }
      },
    }))
  } catch (error) {
    if (error instanceof LeaseError) {
      if (error.code === 'REPLAY_DETECTED' && operation) {
        const recovered = await readOperationReceipt(operation)
        if (recovered) return c.json(recovered)
      }
      const status = error.code === 'LEASE_EXPIRED' ? 410 :
        error.code === 'LEASE_REQUIRED' ? 401 : 403
      return c.json({ error: error.code, message: error.message }, status)
    }
    return c.json({ error: 'LEASE_REQUIRED', message: 'Invalid delegation request' }, 401)
  }
})
