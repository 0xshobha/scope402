import { createHash } from 'node:crypto'
import { decodePaymentRequiredHeader } from '@x402/core/http'
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types'
import { canonicalJson } from './canonical.js'
import { discoverPlotResource } from './discovery.js'
import { executeExactHederaPayment } from './payment-client.js'
import { assertTesseraScope402Policy, selectPayment, type CanvasRegion } from './policy.js'
import type { AgentPolicy, PayerConfig } from './purchase.js'
import type { AgentSubject } from './subject.js'

export type PlotPricing = {
  base_tinybars: string
  per_call_tinybars: string
  calls: 12
  total_tinybars: string
}

export type TesseraPlotResult = {
  status: 'complete'
  canvas_id: 'main'
  region: CanvasRegion
  payment: {
    payer: string
    merchant: string
    amount_tinybars: string
    transaction: string
    hashscan_url: string
  }
  lease: {
    token: string
    lease_id: string
    subject_pubkey: string
    aud: string
    catalogue_hash: string
    tool_ids: ['place_pixel']
    max_calls: 12
    exp: number
    offer_id: string
    hedera_tx_id: string
    policy_hash: string
    resource: CanvasRegion
    root_lease_id: string
  }
}

export type PreparedPlot = {
  payer: string
  requestUrl: string
  paymentUrl: string
  requestBody: string
  required: PaymentRequired
  terms: PaymentRequirements
  quote: { canvas_id: 'main'; region: CanvasRegion; pricing: PlotPricing; policy_hash: string }
  fingerprint: string
  subject: AgentSubject
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}

function parseRegion(value: unknown): CanvasRegion {
  const region = record(value, 'Tessera returned no canvas region')
  if (Object.keys(region).length !== 6 || region.kind !== 'canvas-region' ||
      region.canvasId !== 'main' || !Number.isSafeInteger(region.x) || Number(region.x) < 0 ||
      !Number.isSafeInteger(region.y) || Number(region.y) < 0 ||
      !Number.isSafeInteger(region.width) || Number(region.width) !== 8 ||
      !Number.isSafeInteger(region.height) || Number(region.height) !== 8) {
    throw new Error('Tessera returned a malformed root canvas region')
  }
  return region as CanvasRegion
}

function parseQuote(value: unknown, amount: string) {
  const body = record(value, 'Tessera returned a malformed 402 body')
  const quote = record(body.quote, 'Tessera returned no quote metadata')
  const pricing = record(quote.pricing, 'Tessera returned no quote pricing')
  const parsed: PlotPricing = {
    base_tinybars: String(pricing.base_tinybars ?? ''),
    per_call_tinybars: String(pricing.per_call_tinybars ?? ''),
    calls: Number(pricing.calls) as 12,
    total_tinybars: String(pricing.total_tinybars ?? ''),
  }
  if (quote.canvas_id !== 'main' || !/^[1-9]\d*$/.test(parsed.base_tinybars) ||
      !/^[1-9]\d*$/.test(parsed.per_call_tinybars) || parsed.calls !== 12 ||
      parsed.total_tinybars !== amount || BigInt(parsed.total_tinybars) !==
      BigInt(parsed.base_tinybars) + 12n * BigInt(parsed.per_call_tinybars)) {
    throw new Error('Tessera returned malformed or inconsistent quote metadata')
  }
  return { canvas_id: 'main' as const, region: parseRegion(quote.region), pricing: parsed }
}

function fingerprint(value: Pick<PreparedPlot, 'payer' | 'requestUrl' | 'paymentUrl' |
  'requestBody' | 'required' | 'terms' | 'quote'>) {
  const sealed = {
    payer: value.payer, requestUrl: value.requestUrl, paymentUrl: value.paymentUrl,
    requestBody: value.requestBody, required: value.required, terms: value.terms, quote: value.quote,
  }
  return createHash('sha256').update(canonicalJson(sealed)).digest('hex')
}

export function assertPreparedPlot(policy: AgentPolicy, prepared: PreparedPlot) {
  const selected = selectPayment(prepared.required, prepared.requestUrl, policy.merchant,
    policy.payer, policy.maxPaymentTinybars)
  const info = assertTesseraScope402Policy(prepared.required, {
    subjectPubkey: prepared.subject.subjectPubkey,
    audience: new URL('/v1/tools', policy.auditLabUrl).href,
    resource: prepared.quote.region,
  })
  if (selected.paymentUrl.href !== prepared.paymentUrl ||
      canonicalJson(selected.terms) !== canonicalJson(prepared.terms) ||
      fingerprint(prepared) !== prepared.fingerprint ||
      prepared.quote.pricing.total_tinybars !== selected.terms.amount ||
      prepared.quote.policy_hash !== info.policyHash) {
    throw new Error('Prepared Tessera quote changed before approval')
  }
  return selected
}

export async function preparePlotPurchase(policy: AgentPolicy, subject: AgentSubject,
  request: typeof fetch = fetch): Promise<PreparedPlot> {
  const url = await discoverPlotResource(policy.auditLabUrl, request)
  const requestBody = JSON.stringify({ canvas_id: 'main', subject_pubkey: subject.subjectPubkey })
  const response = await request(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: requestBody,
    redirect: 'error', signal: AbortSignal.timeout(20_000),
  })
  if (response.status !== 402) {
    const failure = await response.json().catch(() => null) as Record<string, unknown> | null
    throw new Error(`Expected 402; Tessera returned HTTP ${response.status}: ${String(failure?.error ?? 'UNKNOWN')}`)
  }
  const header = response.headers.get('PAYMENT-REQUIRED')
  if (!header) throw new Error('Tessera 402 response has no PAYMENT-REQUIRED header')
  const selected = selectPayment(decodePaymentRequiredHeader(header), url.href, policy.merchant,
    policy.payer, policy.maxPaymentTinybars)
  const quote = parseQuote(await response.json(), selected.terms.amount)
  const info = assertTesseraScope402Policy(selected.required, {
    subjectPubkey: subject.subjectPubkey,
    audience: new URL('/v1/tools', policy.auditLabUrl).href,
    resource: quote.region,
  })
  const prepared = {
    payer: policy.payer, requestUrl: url.href, paymentUrl: selected.paymentUrl.href, requestBody,
    required: selected.required, terms: selected.terms,
    quote: { ...quote, policy_hash: String(info.policyHash) }, subject,
  } as Omit<PreparedPlot, 'fingerprint'>
  return { ...prepared, fingerprint: fingerprint(prepared) }
}

function parsePlotResult(value: unknown, prepared: PreparedPlot, policy: AgentPolicy): TesseraPlotResult {
  const result = record(value, 'Tessera returned a malformed plot result')
  const payment = record(result.payment, 'Tessera returned no payment result')
  const lease = record(result.lease, 'Tessera returned no root capability')
  const transaction = typeof payment.transaction === 'string' ? payment.transaction : ''
  const transactionMatch = /^(\d+\.\d+\.[1-9]\d*)@(\d+)\.(\d+)$/.exec(transaction)
  const expectedHashscan = transactionMatch ?
    `https://hashscan.io/testnet/transaction/${transactionMatch[1]}-${transactionMatch[2]}-${transactionMatch[3]}` : ''
  const quoteId = new URL(prepared.paymentUrl).searchParams.get('quote_id')
  const expectedAudience = new URL('/v1/tools', policy.auditLabUrl).href
  if (result.status !== 'complete' || result.canvas_id !== 'main' ||
      canonicalJson(result.region) !== canonicalJson(prepared.quote.region) || !transactionMatch ||
      payment.payer !== policy.payer || payment.merchant !== policy.merchant ||
      payment.amount_tinybars !== prepared.terms.amount || payment.hashscan_url !== expectedHashscan ||
      typeof lease.token !== 'string' || lease.token.length < 32 || typeof lease.lease_id !== 'string' ||
      lease.subject_pubkey !== prepared.subject.subjectPubkey || lease.aud !== expectedAudience ||
      !Array.isArray(lease.tool_ids) || lease.tool_ids.length !== 1 || lease.tool_ids[0] !== 'place_pixel' ||
      lease.max_calls !== 12 || !Number.isSafeInteger(lease.exp) ||
      Number(lease.exp) <= Math.floor(Date.now() / 1_000) || lease.offer_id !== quoteId ||
      lease.hedera_tx_id !== transaction || lease.policy_hash !== prepared.quote.policy_hash ||
      canonicalJson(lease.resource) !== canonicalJson(prepared.quote.region) ||
      lease.root_lease_id !== lease.lease_id || typeof lease.catalogue_hash !== 'string') {
    throw new Error('Tessera returned a root capability inconsistent with the approved purchase')
  }
  return result as unknown as TesseraPlotResult
}

export async function approvePlotPurchase(config: PayerConfig, prepared: PreparedPlot,
  request: typeof fetch = fetch) {
  assertPreparedPlot(config, prepared)
  return executeExactHederaPayment(config, prepared,
    new Set(['PLOT_RETRYABLE', 'PLOT_IN_PROGRESS']),
    (value) => parsePlotResult(value, prepared, config), request)
}
