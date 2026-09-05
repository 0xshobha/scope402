import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { LeaseError } from '../../lease-error.js'
import { verifyBoundInvocation } from '../../scope402/invocation.js'
import { hasExactKeys } from '../../scope402/policy.js'
import { authorizeTesseraPixel, verifyTesseraServiceLease,
  type PlacePixelArgs } from './authorization.js'
import { operationReceipt, readOperationReceipt,
  type OperationReceipt } from '../../scope402/operation-receipts.js'

type PlacePixelRequest = {
  lease: string
  args: PlacePixelArgs
  counter: number
  signature: string
}

function parsePlacePixelRequest(value: unknown): PlacePixelRequest {
  if (!hasExactKeys(value, ['lease', 'args', 'counter', 'signature'])) {
    throw new LeaseError('LEASE_REQUIRED', 'Invalid place_pixel request')
  }
  const body = value as Partial<PlacePixelRequest>
  if (typeof body.lease !== 'string' || typeof body.signature !== 'string' ||
      !Number.isSafeInteger(body.counter) || Number(body.counter) < 1 ||
      !hasExactKeys(body.args, ['canvas_id', 'x', 'y', 'color'])) {
    throw new LeaseError('LEASE_REQUIRED', 'Invalid place_pixel request')
  }
  const args = body.args as Partial<PlacePixelArgs>
  if (typeof args.canvas_id !== 'string' || !args.canvas_id ||
      !Number.isSafeInteger(args.x) || !Number.isSafeInteger(args.y) ||
      typeof args.color !== 'string') {
    throw new LeaseError('LEASE_REQUIRED', 'Invalid place_pixel arguments')
  }
  return body as PlacePixelRequest
}

export const tesseraTools = new Hono()
tesseraTools.use('*', bodyLimit({ maxSize: 32_768 }))
tesseraTools.post('/place_pixel', async (c) => {
  let operation: OperationReceipt | undefined
  try {
    const request = parsePlacePixelRequest(await c.req.json())
    operation = operationReceipt(c.req.header('Idempotency-Key'), 'place_pixel', request)
    const recovered = await readOperationReceipt(operation)
    if (recovered) return c.json(recovered)
    const claims = await verifyTesseraServiceLease(request.lease)
    const invocation = verifyBoundInvocation({ signature: request.signature, claims,
      counter: request.counter, args: request.args, toolId: 'place_pixel' })
    return c.json(await authorizeTesseraPixel(claims, invocation, request.args, operation))
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
    return c.json({ error: 'LEASE_REQUIRED', message: 'Invalid signed invocation' }, 401)
  }
})
