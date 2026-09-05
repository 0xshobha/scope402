import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { LeaseError } from '../../lease-error.js'
import { verifyBoundInvocation } from '../../scope402/invocation.js'
import { hasExactKeys } from '../../scope402/policy.js'
import { authorizeTesseraPixel, verifyTesseraServiceLease,
  type PlacePixelArgs } from './authorization.js'

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
  try {
    const request = parsePlacePixelRequest(await c.req.json())
    const claims = await verifyTesseraServiceLease(request.lease)
    const invocation = verifyBoundInvocation({ signature: request.signature, claims,
      counter: request.counter, args: request.args, toolId: 'place_pixel' })
    const result = await authorizeTesseraPixel(claims, invocation, request.args)
    return c.json({ status: 'PIXEL_PLACED', lease_id: claims.lease_id,
      counter: request.counter, ...result })
  } catch (error) {
    if (error instanceof LeaseError) {
      const status = error.code === 'LEASE_EXPIRED' ? 410 :
        error.code === 'LEASE_REQUIRED' ? 401 : 403
      return c.json({ error: error.code, message: error.message }, status)
    }
    return c.json({ error: 'LEASE_REQUIRED', message: 'Invalid signed invocation' }, 401)
  }
})
