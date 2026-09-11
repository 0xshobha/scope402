import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { PaymentRequirementsV2Schema } from '@x402/core/schemas'
import type { PaymentRequirements } from '@x402/core/types'
import { database, transaction, type TransactionClient } from '../../db.js'
import { PaymentError } from '../../payment-error.js'
import { assertQuoteId, beginRedemptionInTransaction } from '../../payments.js'
import { parseTesseraScope402Extension, tesseraScope402Extension } from '../../scope-extension.js'
import { hasExactKeys } from '../../scope402/policy.js'
import { parseCanvasRegion, rootCanvasRegion, TESSERA_CANVAS_ID } from './resource.js'
import { ensureCanvas, type TesseraLocation } from './canvases.js'

export const TESSERA_MERCHANT_ID = 'tessera'

export type PlotPricing = {
  base_tinybars: string
  per_call_tinybars: string
  calls: 12
  total_tinybars: string
}

function parsePlotPricing(value: unknown): PlotPricing {
  const pricing = value as Partial<PlotPricing> | null
  if (!pricing || typeof pricing !== 'object' ||
      !hasExactKeys(pricing, ['base_tinybars', 'per_call_tinybars', 'calls', 'total_tinybars']) ||
      typeof pricing.base_tinybars !== 'string' || !/^[1-9]\d*$/.test(pricing.base_tinybars) ||
      typeof pricing.per_call_tinybars !== 'string' || !/^[1-9]\d*$/.test(pricing.per_call_tinybars) ||
      pricing.calls !== 12 || typeof pricing.total_tinybars !== 'string' ||
      !/^[1-9]\d*$/.test(pricing.total_tinybars) ||
      BigInt(pricing.total_tinybars) !== BigInt(pricing.base_tinybars) + 12n * BigInt(pricing.per_call_tinybars)) {
    throw new PaymentError('PAYMENT_STATE_ERROR', 'Stored Tessera pricing is invalid')
  }
  return pricing as PlotPricing
}

async function reclaimExpiredSlots(client: TransactionClient, canvasId: string) {
  await client.query(
    `UPDATE tessera_slots AS slot
     SET quote_id = NULL, status = 'available', reservation_expires_at = NULL, transaction_id = NULL
     FROM plot_jobs AS job
     JOIN tool_leases AS lease ON lease.lease_id = job.lease_id
     WHERE slot.quote_id = job.quote_id AND slot.canvas_id = $1 AND slot.status = 'allocated'
       AND lease.expires_at <= clock_timestamp()`,
    [canvasId],
  )
  await client.query(
    `DELETE FROM payment_redemptions AS redemption
     USING tessera_slots AS slot
     WHERE redemption.quote_id = slot.quote_id
       AND redemption.status = 'verifying'
       AND redemption.updated_at <= clock_timestamp() - interval '3 minutes'
       AND slot.canvas_id = $1 AND slot.status = 'pending'
       AND slot.reservation_expires_at <= clock_timestamp()`,
    [canvasId],
  )
  await client.query(
    `UPDATE tessera_slots AS slot
     SET quote_id = NULL, status = 'available', reservation_expires_at = NULL, transaction_id = NULL
     WHERE slot.canvas_id = $1 AND slot.status = 'pending'
       AND slot.reservation_expires_at <= clock_timestamp()
       AND NOT EXISTS (
         SELECT 1 FROM payment_redemptions AS redemption
         WHERE redemption.quote_id = slot.quote_id
           AND (redemption.status IN ('settlement_attempted', 'settlement_unknown', 'settled') OR
             (redemption.status = 'verifying' AND
              redemption.updated_at > clock_timestamp() - interval '3 minutes'))
       )`,
    [canvasId],
  )
}

export async function createPlotQuote(subjectPubkey: string, endpoint: string,
  requirements: PaymentRequirements, pricing: PlotPricing, audience: string, requestedSlot?: number,
  canvasId = TESSERA_CANVAS_ID, location?: TesseraLocation) {
  if (pricing.total_tinybars !== requirements.amount) {
    throw new PaymentError('PAYMENT_STATE_ERROR', 'Tessera pricing and payment amount disagree')
  }
  return transaction(async (client) => {
    await ensureCanvas(client, canvasId, location)
    await reclaimExpiredSlots(client, canvasId)
    const available = await client.query(
      `SELECT slot FROM tessera_slots
       WHERE canvas_id = $1 AND status = 'available' AND ($2::integer IS NULL OR slot = $2)
       ORDER BY slot FOR UPDATE SKIP LOCKED LIMIT 1`,
      [canvasId, requestedSlot ?? null],
    )
    if (available.rowCount !== 1) {
      throw new PaymentError(requestedSlot === undefined ? 'CANVAS_FULL' : 'REGION_UNAVAILABLE',
        requestedSlot === undefined ? 'No Tessera root region is currently available' :
          'The selected Tessera region is no longer available')
    }
    const slot = Number(available.rows[0].slot)
    const resource = rootCanvasRegion(slot, canvasId)
    const extensions = tesseraScope402Extension(subjectPubkey, resource, audience)
    const quoteId = randomUUID()
    const resourceUrl = new URL(endpoint)
    resourceUrl.searchParams.set('quote_id', quoteId)
    const binding = { canvas_id: canvasId, ...(requestedSlot === undefined ? {} : { slot }),
      ...(location === undefined ? {} : { location }) }
    await client.query(
      `INSERT INTO payment_quotes
         (quote_id, repo_url, subject_pubkey, resource_url, requirements, expires_at,
          pricing, scope402_extension, policy_hash, merchant_id, request_binding)
       VALUES ($1, NULL, $2, $3, $4, clock_timestamp() + interval '5 minutes', $5, $6, $7, $8, $9)`,
      [quoteId, subjectPubkey, resourceUrl.href, JSON.stringify(requirements), JSON.stringify(pricing),
        JSON.stringify(extensions), extensions.scope402.info.policyHash, TESSERA_MERCHANT_ID,
        JSON.stringify(binding)],
    )
    const reserved = await client.query(
      `UPDATE tessera_slots SET quote_id = $3, status = 'pending',
         reservation_expires_at = clock_timestamp() + interval '5 minutes'
       WHERE canvas_id = $1 AND slot = $2 AND status = 'available' RETURNING slot`,
      [canvasId, slot, quoteId],
    )
    if (reserved.rowCount !== 1) throw new Error('Tessera slot changed during reservation')
    const persistedLocation = (await client.query(
      `SELECT latitude, longitude FROM tessera_canvases WHERE canvas_id = $1`, [canvasId])).rows[0]
    return { quoteId, resourceUrl: resourceUrl.href, resource, extensions, pricing,
      location: { latitude: Number(persistedLocation.latitude), longitude: Number(persistedLocation.longitude) } }
  })
}

export async function loadPlotQuote(quoteId: string, canvasId: string, subjectPubkey: string,
  allowExpired = false, requestedSlot?: number, location?: TesseraLocation) {
  assertQuoteId(quoteId)
  const result = await database().query(
    `SELECT quote.resource_url, quote.requirements, quote.pricing, quote.scope402_extension,
            quote.policy_hash, quote.request_binding, slot.slot, slot.status,
            slot.reservation_expires_at, slot.transaction_id
     FROM payment_quotes AS quote
     JOIN tessera_slots AS slot ON slot.quote_id = quote.quote_id
     WHERE quote.quote_id = $1 AND quote.subject_pubkey = $2 AND quote.merchant_id = $3
       AND (($4::boolean AND slot.status IN ('pending', 'allocated')) OR
         (NOT $4::boolean AND quote.expires_at > clock_timestamp() AND slot.status = 'pending' AND
          slot.reservation_expires_at > clock_timestamp()))`,
    [quoteId, subjectPubkey, TESSERA_MERCHANT_ID, allowExpired],
  )
  if (result.rowCount !== 1) {
    throw new PaymentError('QUOTE_EXPIRED', 'Tessera quote is missing, expired, or no longer owns its region')
  }
  const row = result.rows[0]
  if (!isDeepStrictEqual(row.request_binding,
    { canvas_id: canvasId, ...(requestedSlot === undefined ? {} : { slot: requestedSlot }),
      ...(location === undefined ? {} : { location }) })) {
    throw new PaymentError('PAYMENT_REQUIREMENTS_MISMATCH', 'Tessera quote is bound to another request')
  }
  const extensions = parseTesseraScope402Extension(row.scope402_extension)
  const resource = parseCanvasRegion(extensions.scope402.info.resource)
  if (row.policy_hash !== extensions.scope402.info.policyHash ||
      extensions.scope402.info.subject.publicKey !== subjectPubkey ||
      resource.canvasId !== canvasId || !isDeepStrictEqual(resource, rootCanvasRegion(Number(row.slot), canvasId)) ||
      extensions.scope402.info.audience !== new URL('/v1/tools', String(row.resource_url)).href) {
    throw new PaymentError('PAYMENT_STATE_ERROR', 'Stored Tessera quote policy is inconsistent')
  }
  const requirements = PaymentRequirementsV2Schema.parse(row.requirements) as PaymentRequirements
  const pricing = parsePlotPricing(row.pricing)
  if (pricing.total_tinybars !== requirements.amount) {
    throw new PaymentError('PAYMENT_STATE_ERROR', 'Stored Tessera price does not match payment terms')
  }
  return {
    resourceUrl: String(row.resource_url), requirements, pricing, extensions, resource,
    policyHash: extensions.scope402.info.policyHash, slot: Number(row.slot), status: String(row.status),
    transactionId: row.transaction_id === null ? undefined : String(row.transaction_id),
  }
}

export async function beginPlotPayment(transactionId: string, quoteId: string) {
  assertQuoteId(quoteId)
  await transaction(async (client) => {
    const protectedSlot = await client.query(
      `UPDATE tessera_slots AS slot
       SET reservation_expires_at = clock_timestamp() + interval '3 minutes'
       FROM payment_quotes AS quote
       WHERE slot.quote_id = quote.quote_id AND quote.quote_id = $1
         AND slot.status = 'pending' AND quote.expires_at > clock_timestamp()
         AND slot.reservation_expires_at > clock_timestamp()
       RETURNING slot.slot`,
      [quoteId],
    )
    if (protectedSlot.rowCount !== 1) {
      throw new PaymentError('QUOTE_EXPIRED',
        'Tessera quote expired or lost its reservation before payment began')
    }
    await beginRedemptionInTransaction(client, transactionId, quoteId)
  })
}
