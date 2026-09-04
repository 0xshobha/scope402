import { createPublicKey } from 'node:crypto'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http'
import { PaymentPayloadV2Schema } from '@x402/core/schemas'
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from '@x402/core/types'
import { ExactHederaScheme } from '@x402/hedera/exact/server'
import { getHederaSupport } from './blocky.js'
import { scanRepository } from './github.js'
import { issueLease } from './leases.js'
import { PaymentError } from './payment-error.js'
import { assertQuotedPayment, createQuote, loadQuote } from './payments.js'
import { hashscanUrl, settlePayment } from './settlement.js'

export type ScanRequest = { repo_url: string; subject_pubkey: string }

export function parseScanRequest(value: unknown): ScanRequest {
  if (typeof value !== 'object' || value === null) throw new Error('Expected a JSON object')
  const { repo_url, subject_pubkey } = value as Record<string, unknown>
  if (typeof repo_url !== 'string' || typeof subject_pubkey !== 'string') {
    throw new Error('repo_url and subject_pubkey are required strings')
  }
  const repo = new URL(repo_url)
  if (repo.protocol !== 'https:' || repo.hostname !== 'github.com' || repo.port ||
      repo.username || repo.password || repo.search || repo.hash ||
      !/^\/[\w.-]+\/[\w.-]+\/?$/.test(repo.pathname)) {
    throw new Error('repo_url must be an HTTPS GitHub owner/repository URL')
  }
  try {
    const key = createPublicKey({
      key: Buffer.from(subject_pubkey, 'base64url'), format: 'der', type: 'spki',
    })
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new Error('Wrong curve')
    }
  } catch {
    throw new Error('subject_pubkey must be a base64url-encoded P-256 SPKI public key')
  }
  return { repo_url, subject_pubkey }
}

export function paymentConfig() {
  const payTo = process.env.HEDERA_MERCHANT_ACCOUNT_ID
  const amount = process.env.SCAN_PRICE_TINYBARS ?? '100000'
  if (!payTo || !/^\d+\.\d+\.[1-9]\d*$/.test(payTo)) {
    throw new Error('Set HEDERA_MERCHANT_ACCOUNT_ID to the merchant account ID')
  }
  if (!/^[1-9]\d*$/.test(amount) || BigInt(amount) > 100_000_000n) {
    throw new Error('SCAN_PRICE_TINYBARS must be between 1 and 100000000 (1 HBAR)')
  }
  return { payTo, amount }
}

export async function paymentRequired(
  url: string,
  config: ReturnType<typeof paymentConfig>,
  support: Awaited<ReturnType<typeof getHederaSupport>>,
): Promise<PaymentRequired> {
  const requirement = await new ExactHederaScheme().enhancePaymentRequirements({
    scheme: support.scheme, network: support.network, asset: '0.0.0',
    amount: config.amount, payTo: config.payTo, maxTimeoutSeconds: 120, extra: {},
  }, support, [])
  return {
    x402Version: 2,
    error: 'PAYMENT-SIGNATURE header is required',
    resource: { url, description: 'AuditLab repository scan', mimeType: 'application/json' },
    accepts: [requirement],
  }
}

export function settledPaymentDetails(requirements: PaymentRequirements,
  receipt: { payer?: string; transaction: string }) {
  return {
    payer: receipt.payer,
    merchant: requirements.payTo,
    amount_tinybars: requirements.amount,
    transaction: receipt.transaction,
    hashscan_url: hashscanUrl(receipt.transaction),
  }
}

export const scans = new Hono()
scans.use('*', bodyLimit({ maxSize: 8192 }))
scans.post('/', async (c) => {
  let request: ScanRequest
  try {
    request = parseScanRequest(await c.req.json())
  } catch (error) {
    return c.json({ error: 'INVALID_REQUEST', message: error instanceof Error ? error.message : 'Invalid JSON' }, 400)
  }
  let payload: PaymentPayload | undefined
  const signature = c.req.header('PAYMENT-SIGNATURE')
  if (signature) {
    try {
      payload = PaymentPayloadV2Schema.parse(decodePaymentSignatureHeader(signature)) as PaymentPayload
    } catch {
      return c.json({ error: 'PAYMENT_INVALID', message: 'Invalid x402 v2 payment header' }, 400)
    }
  }
  try {
    if (payload) {
      const quoteId = c.req.query('quote_id') ?? ''
      const quote = await loadQuote(quoteId, request.repo_url, request.subject_pubkey)
      assertQuotedPayment(payload, quote)
      const receipt = await settlePayment(quoteId, payload, quote.requirements)
      c.header('PAYMENT-RESPONSE', encodePaymentResponseHeader(receipt))
      c.header('Cache-Control', 'no-store')
      const scan = await scanRepository(request.repo_url)
      const lease = await issueLease(request.subject_pubkey, scan, receipt.transaction, quoteId)
      return c.json({ ...scan, status: 'complete',
        payment: settledPaymentDetails(quote.requirements, receipt),
        lease: { token: lease.token, ...lease.claims } })
    }
    let config: ReturnType<typeof paymentConfig>
    try {
      config = paymentConfig()
    } catch (error) {
      return c.json({ error: 'PAYMENT_NOT_CONFIGURED', message: (error as Error).message }, 503)
    }
    const support = await getHederaSupport()
    const draft = await paymentRequired(c.req.url, config, support)
    const quote = await createQuote(request.repo_url, request.subject_pubkey, c.req.url, draft.accepts[0]!)
    const required = { ...draft, resource: { ...draft.resource, url: quote.resourceUrl } }
    c.header('PAYMENT-REQUIRED', encodePaymentRequiredHeader(required))
    c.header('Cache-Control', 'no-store')
    return c.json(required, 402)
  } catch (error) {
    if (error instanceof PaymentError) {
      const status = ['PAYMENT_INVALID', 'PAYMENT_REQUIREMENTS_MISMATCH', 'QUOTE_INVALID'].includes(error.code) ? 400 :
        ['QUOTE_ALREADY_REDEEMED', 'QUOTE_EXPIRED'].includes(error.code) ? 409 : 502
      return c.json({ error: error.code, message: error.message }, status)
    }
    return c.json({ error: payload ? 'SCAN_FAILED' : 'FACILITATOR_ERROR',
      message: error instanceof Error ? error.message : 'Request failed' }, 502)
  }
})
