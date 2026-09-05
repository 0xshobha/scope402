import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader,
  encodePaymentResponseHeader } from '@x402/core/http'
import { PaymentPayloadV2Schema } from '@x402/core/schemas'
import type { PaymentPayload } from '@x402/core/types'
import { getHederaSupport } from './blocky.js'
import { PlotJobError, fulfillPaidPlot } from './merchants/tessera/jobs.js'
import { beginPlotPayment, createPlotQuote, loadPlotQuote,
  type PlotPricing } from './merchants/tessera/quotes.js'
import { TESSERA_CANVAS_ID } from './merchants/tessera/resource.js'
import { PaymentError } from './payment-error.js'
import { assertPaymentAmount, merchantConfig, paymentRequired } from './payment-offer.js'
import { assertQuotedPayment, settledRedemption } from './payments.js'
import { quoteRateLimiter } from './quote-rate-limit.js'
import { assertScope402Echo } from './scope-extension.js'
import { assertP256Subject } from './scope402/subject.js'
import { paymentTransactionId, settleBegunPayment } from './settlement.js'

export type PlotRequest = { canvas_id: string; subject_pubkey: string }

export function parsePlotRequest(value: unknown): PlotRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 2) throw new Error('Expected canvas_id and subject_pubkey')
  const { canvas_id, subject_pubkey } = value as Record<string, unknown>
  if (canvas_id !== TESSERA_CANVAS_ID) throw new Error(`canvas_id must be ${TESSERA_CANVAS_ID}`)
  return { canvas_id, subject_pubkey: assertP256Subject(subject_pubkey) }
}

function positiveInteger(name: string, fallback: string) {
  const value = process.env[name] ?? fallback
  if (!/^[1-9]\d*$/.test(value) || BigInt(value) > 100_000_000n) {
    throw new Error(`${name} must be an integer between 1 and 100000000`)
  }
  return BigInt(value)
}

export function plotPricingConfig() {
  const base = positiveInteger('PLOT_BASE_TINYBARS', '50000')
  const perCall = positiveInteger('PLOT_PER_CALL_TINYBARS', '500')
  if (base + perCall * 12n > 100_000_000n) {
    throw new Error('Tessera root capability price must not exceed 1 HBAR')
  }
  return { base, perCall }
}

export function meterPlot(config = plotPricingConfig()): PlotPricing {
  return {
    base_tinybars: String(config.base), per_call_tinybars: String(config.perCall),
    calls: 12, total_tinybars: String(config.base + config.perCall * 12n),
  }
}

export function plotResourceUrl(requestUrl: string) {
  return new URL('/v1/plots', process.env.AUDITLAB_URL ?? requestUrl).href
}

export const plots = new Hono()
plots.use('*', bodyLimit({ maxSize: 4096 }))
plots.post('/', async (c) => {
  let request: PlotRequest
  try {
    request = parsePlotRequest(await c.req.json())
  } catch (error) {
    return c.json({ error: 'INVALID_REQUEST',
      message: error instanceof Error ? error.message : 'Invalid JSON' }, 400)
  }
  let payload: PaymentPayload | undefined
  const signature = c.req.header('PAYMENT-SIGNATURE')
  if (signature) {
    try {
      payload = PaymentPayloadV2Schema.parse(
        decodePaymentSignatureHeader(signature)) as PaymentPayload
    } catch {
      return c.json({ error: 'PAYMENT_INVALID', message: 'Invalid x402 v2 payment header' }, 400)
    }
  }
  try {
    if (payload) {
      const quoteId = c.req.query('quote_id') ?? ''
      const transactionId = paymentTransactionId(payload)
      const recovered = await settledRedemption(transactionId, quoteId)
      const quote = await loadPlotQuote(quoteId, request.canvas_id, request.subject_pubkey,
        Boolean(recovered))
      assertQuotedPayment(payload, quote)
      assertScope402Echo(payload, quote.extensions)
      if (!recovered) await beginPlotPayment(transactionId, quoteId)
      const receipt = recovered ?? await settleBegunPayment(payload, quote.requirements)
      c.header('PAYMENT-RESPONSE', encodePaymentResponseHeader(receipt))
      c.header('Cache-Control', 'no-store')
      return c.json(await fulfillPaidPlot({ transactionId, quoteId,
        subjectPubkey: request.subject_pubkey, requirements: quote.requirements, receipt,
        policy: quote.extensions.scope402.info }))
    }
    let merchant: ReturnType<typeof merchantConfig>
    let pricing: PlotPricing
    try {
      merchant = merchantConfig()
      pricing = meterPlot()
    } catch (error) {
      return c.json({ error: 'PAYMENT_NOT_CONFIGURED', message: (error as Error).message }, 503)
    }
    const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    const rate = quoteRateLimiter.take(forwarded || c.req.header('x-real-ip') || 'unknown')
    if (!rate.allowed) {
      c.header('Retry-After', String(rate.retryAfterSeconds))
      return c.json({ error: 'QUOTE_RATE_LIMITED',
        message: 'Too many unpaid quote requests; retry later' }, 429)
    }
    const support = await getHederaSupport()
    const endpoint = plotResourceUrl(c.req.url)
    const draft = await paymentRequired(endpoint,
      { ...merchant, amount: assertPaymentAmount(pricing.total_tinybars, 'Tessera') }, support,
      'Tessera 8 by 8 root canvas capability')
    const quote = await createPlotQuote(request.subject_pubkey, endpoint, draft.accepts[0]!,
      pricing, new URL('/v1/tools', process.env.AUDITLAB_URL ?? c.req.url).href)
    const required = { ...draft,
      resource: { ...draft.resource, url: quote.resourceUrl }, extensions: quote.extensions }
    c.header('PAYMENT-REQUIRED', encodePaymentRequiredHeader(required))
    c.header('Cache-Control', 'no-store')
    return c.json({ ...required, quote: { canvas_id: TESSERA_CANVAS_ID,
      region: quote.resource, pricing } }, 402)
  } catch (error) {
    if (error instanceof PlotJobError) {
      const status = error.code === 'PLOT_IN_PROGRESS' ? 409 :
        error.code === 'PLOT_RESERVATION_LOST' ? 409 : 503
      return c.json({ error: error.code, message: error.message }, status)
    }
    if (error instanceof PaymentError) {
      const status = ['PAYMENT_INVALID', 'PAYMENT_REQUIREMENTS_MISMATCH', 'QUOTE_INVALID']
        .includes(error.code) ? 400 :
        ['QUOTE_ALREADY_REDEEMED', 'QUOTE_EXPIRED', 'CANVAS_FULL'].includes(error.code) ? 409 : 502
      return c.json({ error: error.code, message: error.message }, status)
    }
    return c.json({ error: payload ? 'PLOT_FAILED' : 'FACILITATOR_ERROR',
      message: error instanceof Error ? error.message : 'Request failed' }, 502)
  }
})
