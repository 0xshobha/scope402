import { createHash } from 'node:crypto'
import { canonicalJson } from '../../canonical.js'
import { transaction, type TransactionClient } from '../../db.js'
import { LeaseError } from '../../lease-error.js'
import { authorizeAndCommitInTransaction } from '../../scope402/authorize.js'
import type { Scope402Invocation } from '../../scope402/invocation.js'
import { loadServiceKey, verifyLease, type BaseLeaseClaims } from '../../scope402/lease.js'
import type { CanvasRegionResource } from '../../scope402/policy.js'
import { authorizeCanvasPoint, parseCanvasRegion } from './resource.js'
import { isTesseraColor, type TesseraColor } from './palette.js'
import { TESSERA_MERCHANT_ID } from './quotes.js'

export type PlacePixelArgs = {
  canvas_id: string
  x: number
  y: number
  color: TesseraColor
}

export type TesseraLeaseClaims = BaseLeaseClaims & {
  tool_ids: ['place_pixel']
  max_calls: 12
  resource: CanvasRegionResource
  policy_hash: string
}

export async function verifyTesseraServiceLease(token: string): Promise<TesseraLeaseClaims> {
  const claims = verifyLease(token, await loadServiceKey())
  let resource: CanvasRegionResource
  try {
    resource = parseCanvasRegion(claims.resource)
  } catch {
    throw new LeaseError('LEASE_REQUIRED', 'Tessera lease resource is invalid')
  }
  const audience = new URL('/v1/tools',
    process.env.AUDITLAB_URL ?? 'http://127.0.0.1:3000').href
  const catalogueHash = createHash('sha256')
    .update(canonicalJson(['place_pixel'])).digest('hex')
  if (claims.max_calls !== 12 || claims.tool_ids.length !== 1 ||
      claims.tool_ids[0] !== 'place_pixel' || claims.aud !== audience ||
      claims.catalogue_hash !== catalogueHash ||
      !/^sha256:[0-9a-f]{64}$/.test(claims.policy_hash ?? '')) {
    throw new LeaseError('LEASE_REQUIRED', 'Tessera lease claims are invalid')
  }
  return { ...claims, resource, policy_hash: claims.policy_hash! } as TesseraLeaseClaims
}

export async function authorizeTesseraPixel(claims: TesseraLeaseClaims,
  invocation: Scope402Invocation, args: PlacePixelArgs) {
  return transaction((client) => authorizeAndCommitInTransaction(
    client, claims, invocation, args, tesseraPixelAdapter))
}

const tesseraPixelAdapter = {
  authorizeResourceAction: async (_client: TransactionClient,
    context: { state: { merchantId?: string; resource?: unknown; maxCalls: number; usedCalls: number }
      args: PlacePixelArgs }) => {
    if (context.state.merchantId !== TESSERA_MERCHANT_ID) {
      throw new LeaseError('LEASE_REQUIRED', 'Capability belongs to another merchant')
    }
    if (!isTesseraColor(context.args.color)) {
      throw new LeaseError('INVALID_COLOR', 'Pixel color is not in the Tessera palette')
    }
    const resource = parseCanvasRegion(context.state.resource)
    const point = authorizeCanvasPoint(resource, {
      canvasId: context.args.canvas_id, x: context.args.x, y: context.args.y,
    })
    return { point, color: context.args.color,
      remainingCalls: context.state.maxCalls - context.state.usedCalls - 1 }
  },
  commitBusinessMutation: async (client: TransactionClient,
    context: { state: { leaseId: string } }, authorized: {
      point: { canvasId: string; x: number; y: number }
      color: TesseraColor
      remainingCalls: number
    }) => {
    const result = await client.query(
      `INSERT INTO tessera_pixels (canvas_id, x, y, color, lease_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (canvas_id, x, y) DO UPDATE
       SET color = EXCLUDED.color, lease_id = EXCLUDED.lease_id,
           updated_at = clock_timestamp()
       RETURNING canvas_id, x, y, color, extract(epoch from updated_at)::bigint AS updated_at`,
      [authorized.point.canvasId, authorized.point.x, authorized.point.y,
        authorized.color, context.state.leaseId],
    )
    if (result.rowCount !== 1) throw new Error('Pixel mutation did not commit')
    const row = result.rows[0]
    return {
      pixel: { canvas_id: String(row.canvas_id), x: Number(row.x), y: Number(row.y),
        color: String(row.color), updated_at: Number(row.updated_at) },
      remaining_calls: authorized.remainingCalls,
    }
  },
}
