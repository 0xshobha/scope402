import { createHash } from 'node:crypto'
import { decodePaymentRequiredHeader, decodePaymentResponseHeader,
  encodePaymentSignatureHeader } from '@x402/core/http'
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types'
import { createClientHederaSigner, inspectHederaTransaction, PrivateKey } from '@x402/hedera'
import { ExactHederaScheme } from '@x402/hedera/exact/client'
import { canonicalJson } from './canonical.js'
import { discoverScanResource } from './discovery.js'
import { assertScope402Policy, selectPayment } from './policy.js'
import type { AgentSubject } from './subject.js'

type Pricing = {
  base_tinybars: string
  per_file_tinybars: string
  file_cap: number
  files_considered: number
  files_charged: number
  total_tinybars: string
}

export type Finding = { id: string; severity: string; message: string }

export type ScanResult = {
  status: 'complete'
  scan_id: string
  repo: string
  commit_sha: string
  findings: Finding[]
  payment: {
    payer?: string
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
    tool_ids: ['finding_details']
    max_calls: 3
    exp: number
    hedera_tx_id: string
    scan_id: string
  }
}

export type AgentPolicy = {
  auditLabUrl: URL
  payer: string
  merchant: string
  maxPaymentTinybars: string
}

export type PayerConfig = AgentPolicy & { payerPrivateKey: string }

export type PreparedScan = {
  payer: string
  repoUrl: string
  requestUrl: string
  paymentUrl: string
  requestBody: string
  required: PaymentRequired
  terms: PaymentRequirements
  quote: { repository: string; commit_sha: string; pricing: Pricing }
  fingerprint: string
  subject: AgentSubject
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}

export function normalizeRepositoryUrl(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('repo_url must be an HTTPS GitHub owner/repository URL')
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username ||
      url.password || url.search || url.hash || !/^\/[\w.-]+\/[\w.-]+\/?$/.test(url.pathname)) {
    throw new Error('repo_url must be an HTTPS GitHub owner/repository URL')
  }
  url.pathname = url.pathname.replace(/\/$/, '')
  return url.href
}

function parseQuote(value: unknown, amount: string) {
  const body = record(value, 'AuditLab returned a malformed 402 body')
  const quote = record(body.quote, 'AuditLab returned no quote metadata')
  const pricing = record(quote.pricing, 'AuditLab returned no quote pricing')
  const parsed: Pricing = {
    base_tinybars: String(pricing.base_tinybars ?? ''),
    per_file_tinybars: String(pricing.per_file_tinybars ?? ''),
    file_cap: Number(pricing.file_cap),
    files_considered: Number(pricing.files_considered),
    files_charged: Number(pricing.files_charged),
    total_tinybars: String(pricing.total_tinybars ?? ''),
  }
  if (typeof quote.repository !== 'string' ||
      typeof quote.commit_sha !== 'string' || !/^[0-9a-f]{40}$/.test(quote.commit_sha) ||
      !/^[1-9]\d*$/.test(parsed.base_tinybars) || !/^[1-9]\d*$/.test(parsed.per_file_tinybars) ||
      !Number.isSafeInteger(parsed.file_cap) || parsed.file_cap < 1 ||
      !Number.isSafeInteger(parsed.files_considered) || parsed.files_considered < 0 ||
      !Number.isSafeInteger(parsed.files_charged) || parsed.files_charged < 0 ||
      parsed.files_charged > parsed.file_cap || parsed.files_charged > parsed.files_considered ||
      parsed.total_tinybars !== amount) {
    throw new Error('AuditLab returned malformed or inconsistent quote metadata')
  }
  return { repository: quote.repository, commit_sha: quote.commit_sha, pricing: parsed }
}

function fingerprint(value: Pick<PreparedScan, 'payer' | 'repoUrl' | 'requestUrl' | 'paymentUrl' |
  'requestBody' | 'required' | 'terms' | 'quote'>) {
  const sealed = {
    payer: value.payer,
    repoUrl: value.repoUrl,
    requestUrl: value.requestUrl,
    paymentUrl: value.paymentUrl,
    requestBody: value.requestBody,
    required: value.required,
    terms: value.terms,
    quote: value.quote,
  }
  return createHash('sha256').update(canonicalJson(sealed)).digest('hex')
}

export function assertPreparedScan(policy: AgentPolicy, prepared: PreparedScan) {
  const selected = selectPayment(prepared.required, prepared.requestUrl, policy.merchant,
    policy.payer, policy.maxPaymentTinybars)
  if (selected.paymentUrl.href !== prepared.paymentUrl ||
      canonicalJson(selected.terms) !== canonicalJson(prepared.terms) ||
      fingerprint(prepared) !== prepared.fingerprint ||
      prepared.quote.pricing.total_tinybars !== selected.terms.amount) {
    throw new Error('Prepared quote changed before approval')
  }
  return selected
}

export async function prepareScanPurchase(policy: AgentPolicy, repoInput: string,
  subject: AgentSubject, request: typeof fetch = fetch): Promise<PreparedScan> {
  const repoUrl = normalizeRepositoryUrl(repoInput)
  const url = await discoverScanResource(policy.auditLabUrl, request)
  const requestBody = JSON.stringify({ repo_url: repoUrl, subject_pubkey: subject.subjectPubkey })
  const response = await request(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: requestBody,
    redirect: 'error', signal: AbortSignal.timeout(20_000),
  })
  if (response.status !== 402) {
    const failure = await response.json().catch(() => null) as Record<string, unknown> | null
    throw new Error(`Expected 402; AuditLab returned HTTP ${response.status}: ${String(failure?.error ?? 'UNKNOWN')}`)
  }
  const header = response.headers.get('PAYMENT-REQUIRED')
  if (!header) throw new Error('402 response has no PAYMENT-REQUIRED header')
  const selected = selectPayment(decodePaymentRequiredHeader(header), url.href, policy.merchant,
    policy.payer, policy.maxPaymentTinybars)
  const quote = parseQuote(await response.json(), selected.terms.amount)
  assertScope402Policy(selected.required, { subjectPubkey: subject.subjectPubkey,
    repository: quote.repository, commitSha: quote.commit_sha,
    audience: new URL('/v1/tools', policy.auditLabUrl).href })
  const prepared = {
    payer: policy.payer, repoUrl, requestUrl: url.href, paymentUrl: selected.paymentUrl.href, requestBody,
    required: selected.required, terms: selected.terms, quote, subject,
  } as Omit<PreparedScan, 'fingerprint'>
  return { ...prepared, fingerprint: fingerprint(prepared) }
}

function parseScanResult(value: unknown, prepared: PreparedScan, policy: AgentPolicy): ScanResult {
  const result = record(value, 'AuditLab returned a malformed scan result')
  const payment = record(result.payment, 'AuditLab returned no payment result')
  const lease = record(result.lease, 'AuditLab returned no ToolLease')
  const transaction = typeof payment.transaction === 'string' ? payment.transaction : ''
  const transactionMatch = /^(\d+\.\d+\.[1-9]\d*)@(\d+)\.(\d+)$/.exec(transaction)
  const expectedHashscan = transactionMatch ?
    `https://hashscan.io/testnet/transaction/${transactionMatch[1]}-${transactionMatch[2]}-${transactionMatch[3]}` : ''
  const expectedAudience = new URL('/v1/tools', policy.auditLabUrl).href
  if (result.status !== 'complete' || typeof result.scan_id !== 'string' ||
      result.repo !== prepared.quote.repository || result.commit_sha !== prepared.quote.commit_sha ||
      !Array.isArray(result.findings) || !transactionMatch ||
      payment.payer !== policy.payer || payment.merchant !== policy.merchant ||
      payment.amount_tinybars !== prepared.terms.amount || payment.hashscan_url !== expectedHashscan ||
      typeof lease.token !== 'string' || lease.token.length < 32 || typeof lease.lease_id !== 'string' ||
      lease.subject_pubkey !== prepared.subject.subjectPubkey || lease.hedera_tx_id !== payment.transaction ||
      lease.scan_id !== result.scan_id || lease.aud !== expectedAudience || lease.max_calls !== 3 ||
      !Array.isArray(lease.tool_ids) || lease.tool_ids.length !== 1 ||
      lease.tool_ids[0] !== 'finding_details' || !Number.isSafeInteger(lease.exp) ||
      Number(lease.exp) <= Math.floor(Date.now() / 1000)) {
    throw new Error('AuditLab returned a scan result inconsistent with the approved purchase')
  }
  for (const finding of result.findings) {
    const item = record(finding, 'AuditLab returned a malformed finding')
    if (typeof item.id !== 'string' || typeof item.severity !== 'string' || typeof item.message !== 'string') {
      throw new Error('AuditLab returned a malformed finding')
    }
  }
  return result as unknown as ScanResult
}

export async function approveScanPurchase(config: PayerConfig, prepared: PreparedScan,
  request: typeof fetch = fetch): Promise<{ receipt: ReturnType<typeof decodePaymentResponseHeader>;
    result: ScanResult }> {
  const { required, terms } = assertPreparedScan(config, prepared)
  const signer = createClientHederaSigner(config.payer, PrivateKey.fromStringECDSA(config.payerPrivateKey),
    { network: 'hedera:testnet' })
  const signed = await new ExactHederaScheme(signer).createPaymentPayload(2, terms)
  const transaction = signed.payload.transaction
  if (typeof transaction !== 'string') throw new Error('SDK returned no signed transfer')
  const inspected = inspectHederaTransaction(transaction)
  if (inspected.hbarTransfers.find((entry) => entry.accountId === config.payer)?.amount !== `-${terms.amount}` ||
      inspected.hbarTransfers.find((entry) => entry.accountId === config.merchant)?.amount !== terms.amount) {
    throw new Error('Signed transfer does not match the approved payment')
  }
  const paymentSignature = encodePaymentSignatureHeader({
    x402Version: 2, accepted: terms, resource: required.resource, payload: signed.payload,
    extensions: required.extensions ?? undefined,
  })
  let response: Response | undefined
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      response = await request(prepared.paymentUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json',
          'PAYMENT-SIGNATURE': paymentSignature }, body: prepared.requestBody,
        redirect: 'error', signal: AbortSignal.timeout(60_000),
      })
    } catch (error) {
      if (attempt === 3) throw error
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      continue
    }
    if (response.ok) break
    const failure = await response.json().catch(() => null) as Record<string, unknown> | null
    const code = String(failure?.error ?? 'UNKNOWN')
    if (!['SCAN_RETRYABLE', 'SCAN_IN_PROGRESS'].includes(code) || attempt === 3) {
      throw new Error(`Paid retry returned HTTP ${response.status}: ${code}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  if (!response?.ok) throw new Error('Paid scan recovery did not complete')
  const receiptHeader = response.headers.get('PAYMENT-RESPONSE')
  if (!receiptHeader) throw new Error('API returned success without PAYMENT-RESPONSE')
  const receipt = decodePaymentResponseHeader(receiptHeader)
  if (receipt.success !== true || !receipt.transaction || receipt.network !== 'hedera:testnet' ||
      receipt.payer !== config.payer) throw new Error('API returned an invalid settlement receipt')
  return { receipt, result: parseScanResult(await response.json(), prepared, config) }
}
