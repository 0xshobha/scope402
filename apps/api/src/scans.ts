import { createPublicKey } from 'node:crypto'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { encodePaymentRequiredHeader } from '@x402/core/http'
import type { PaymentRequired } from '@x402/core/types'
import { ExactHederaScheme } from '@x402/hedera/exact/server'
import { getHederaSupport } from './blocky.js'

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

export const scans = new Hono()
scans.use('*', bodyLimit({ maxSize: 8192 }))
scans.post('/', async (c) => {
  try {
    parseScanRequest(await c.req.json())
  } catch (error) {
    return c.json({ error: 'INVALID_REQUEST', message: error instanceof Error ? error.message : 'Invalid JSON' }, 400)
  }
  if (c.req.header('PAYMENT-SIGNATURE')) {
    return c.json({ error: 'PAYMENT_PROCESSING_UNAVAILABLE' }, 501)
  }
  let config: ReturnType<typeof paymentConfig>
  try {
    config = paymentConfig()
  } catch (error) {
    return c.json({ error: 'PAYMENT_NOT_CONFIGURED', message: (error as Error).message }, 503)
  }
  try {
    const support = await getHederaSupport()
    const required = await paymentRequired(c.req.url, config, support)
    c.header('PAYMENT-REQUIRED', encodePaymentRequiredHeader(required))
    c.header('Cache-Control', 'no-store')
    return c.json(required, 402)
  } catch (error) {
    return c.json({ error: 'FACILITATOR_ERROR', message: error instanceof Error ? error.message : 'Discovery failed' }, 502)
  }
})
