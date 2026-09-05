import { createPublicKey } from 'node:crypto'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http'
import { PaymentPayloadV2Schema } from '@x402/core/schemas'
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from '@x402/core/types'
import { ExactHederaScheme } from '@x402/hedera/exact/server'
import { getHederaSupport } from './blocky.js'
import { GitHubRequestError, prepareRepository, scanRepositorySnapshot } from './github.js'
import { PaymentError } from './payment-error.js'
import { settledPaymentDetails } from './payment-receipt.js'
import { assertQuotedPayment, createQuote, loadQuote, settledRedemption, type Pricing } from './payments.js'
import { quoteRateLimiter } from './quote-rate-limit.js'
import { fulfillPaidScan, ScanJobError } from './scan-jobs.js'
import { paymentTransactionId, settlePayment } from './settlement.js'
import { assertScope402Echo, scope402Extension } from './scope-extension.js'

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

export function merchantConfig() {
  const payTo = process.env.HEDERA_MERCHANT_ACCOUNT_ID
  if (!payTo || !/^\d+\.\d+\.[1-9]\d*$/.test(payTo)) {
    throw new Error('Set HEDERA_MERCHANT_ACCOUNT_ID to the merchant account ID')
  }
  return { payTo }
}

export function assertPaymentAmount(amount: string) {
  if (!/^[1-9]\d*$/.test(amount) || BigInt(amount) > 100_000_000n) {
    throw new Error('Metered scan amount must be between 1 and 100000000 tinybars (1 HBAR)')
  }
  return amount
}

function positiveInteger(name: string, fallback: string, maximum: bigint) {
  const value = process.env[name] ?? fallback
  if (!/^[1-9]\d*$/.test(value) || BigInt(value) > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`)
  }
  return BigInt(value)
}

export function pricingConfig() {
  const base = positiveInteger('SCAN_BASE_PRICE_TINYBARS', '50000', 100_000_000n)
  const perFile = positiveInteger('SCAN_PER_FILE_TINYBARS', '500', 100_000_000n)
  const cap = positiveInteger('SCAN_FILE_CAP', '100', 1_000n)
  if (base + perFile * cap > 100_000_000n) {
    throw new Error('Maximum metered scan price must not exceed 1 HBAR')
  }
  return { base, perFile, cap: Number(cap) }
}

export function meterScan(filesConsidered: number,
  config: ReturnType<typeof pricingConfig> = pricingConfig()): Pricing {
  if (!Number.isSafeInteger(filesConsidered) || filesConsidered < 0) {
    throw new Error('filesConsidered must be a non-negative integer')
  }
  const filesCharged = Math.min(filesConsidered, config.cap)
  return {
    base_tinybars: String(config.base), per_file_tinybars: String(config.perFile),
    file_cap: config.cap, files_considered: filesConsidered, files_charged: filesCharged,
    total_tinybars: String(config.base + config.perFile * BigInt(filesCharged)),
  }
}

export async function paymentRequired(
  url: string,
  config: { payTo: string; amount: string },
  support: Awaited<ReturnType<typeof getHederaSupport>>,
  description = 'AuditLab repository scan',
  extensions?: Record<string, unknown>,
): Promise<PaymentRequired> {
  const requirement = await new ExactHederaScheme().enhancePaymentRequirements({
    scheme: support.scheme, network: support.network, asset: '0.0.0',
    amount: config.amount, payTo: config.payTo, maxTimeoutSeconds: 120, extra: {},
  }, support, [])
  return {
    x402Version: 2,
    error: 'PAYMENT-SIGNATURE header is required',
    resource: { url, description, mimeType: 'application/json' },
    accepts: [requirement],
    ...(extensions ? { extensions } : {}),
  }
}

export { settledPaymentDetails } from './payment-receipt.js'

export function scanResourceUrl(requestUrl: string) {
  return new URL('/v1/scans', process.env.AUDITLAB_URL ?? requestUrl).href
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
      const transactionId = paymentTransactionId(payload)
      const recovered = await settledRedemption(transactionId, quoteId)
      const quote = await loadQuote(quoteId, request.repo_url, request.subject_pubkey, Boolean(recovered))
      if (!quote.scope402Extension) {
        throw new PaymentError('QUOTE_EXPIRED', 'Quote predates persisted Scope402 policy; request a new quote')
      }
      const extensions = quote.scope402Extension
      assertQuotedPayment(payload, quote)
      assertScope402Echo(payload, extensions)
      const receipt = recovered ?? await settlePayment(quoteId, payload, quote.requirements)
      c.header('PAYMENT-RESPONSE', encodePaymentResponseHeader(receipt))
      c.header('Cache-Control', 'no-store')
      const runScan = quote.snapshot ? async () => scanRepositorySnapshot(quote.snapshot!) : undefined
      return c.json(await fulfillPaidScan({ transactionId, quoteId, repoUrl: request.repo_url,
        subjectPubkey: request.subject_pubkey, requirements: quote.requirements, receipt,
        policy: quote.scope402Extension.scope402.info }, runScan))
    }
    let merchant: ReturnType<typeof merchantConfig>
    let pricingPolicy: ReturnType<typeof pricingConfig>
    let snapshot: Awaited<ReturnType<typeof prepareRepository>>
    let pricing: Pricing
    try {
      merchant = merchantConfig()
      pricingPolicy = pricingConfig()
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
    try {
      snapshot = await prepareRepository(request.repo_url)
      pricing = meterScan(snapshot.root_files.length, pricingPolicy)
    } catch (error) {
      if (error instanceof GitHubRequestError &&
          (error.status === 404 || (error.status === 403 && !error.retryable))) {
        return c.json({ error: 'REPOSITORY_NOT_FOUND',
          message: 'GitHub repository was not found or is not public' }, 404)
      }
      return c.json({ error: 'QUOTE_UNAVAILABLE', message: (error as Error).message }, 503)
    }
    const support = await getHederaSupport()
    const endpoint = scanResourceUrl(c.req.url)
    const description = `AuditLab scan of ${snapshot.repo}@${snapshot.commit_sha} (${pricing.files_considered} root files)`
    const config = { ...merchant, amount: assertPaymentAmount(pricing.total_tinybars) }
    const extensions = scope402Extension(request.subject_pubkey, snapshot,
      new URL('/v1/tools', process.env.AUDITLAB_URL ?? c.req.url).href)
    const draft = await paymentRequired(endpoint, config, support, description, extensions)
    const quote = await createQuote(request.repo_url, request.subject_pubkey, endpoint,
      draft.accepts[0]!, snapshot, pricing, extensions)
    const required = { ...draft, resource: { ...draft.resource, url: quote.resourceUrl } }
    c.header('PAYMENT-REQUIRED', encodePaymentRequiredHeader(required))
    c.header('Cache-Control', 'no-store')
    return c.json({ ...required, quote: { repository: snapshot.repo,
      commit_sha: snapshot.commit_sha, pricing } }, 402)
  } catch (error) {
    if (error instanceof ScanJobError) {
      return c.json({ error: error.code, message: error.message }, error.code === 'SCAN_IN_PROGRESS' ? 409 : 503)
    }
    if (error instanceof PaymentError) {
      const status = ['PAYMENT_INVALID', 'PAYMENT_REQUIREMENTS_MISMATCH', 'QUOTE_INVALID'].includes(error.code) ? 400 :
        ['QUOTE_ALREADY_REDEEMED', 'QUOTE_EXPIRED'].includes(error.code) ? 409 : 502
      return c.json({ error: error.code, message: error.message }, status)
    }
    return c.json({ error: payload ? 'SCAN_FAILED' : 'FACILITATOR_ERROR',
      message: error instanceof Error ? error.message : 'Request failed' }, 502)
  }
})
