import type { PaymentRequired } from '@x402/core/types'
import { ExactHederaScheme } from '@x402/hedera/exact/server'
import { getHederaSupport } from './blocky.js'

export function merchantConfig() {
  const payTo = process.env.HEDERA_MERCHANT_ACCOUNT_ID
  if (!payTo || !/^\d+\.\d+\.[1-9]\d*$/.test(payTo)) {
    throw new Error('Set HEDERA_MERCHANT_ACCOUNT_ID to the merchant account ID')
  }
  return { payTo }
}

export function assertPaymentAmount(amount: string, label = 'Payment') {
  if (!/^[1-9]\d*$/.test(amount) || BigInt(amount) > 100_000_000n) {
    throw new Error(`${label} amount must be between 1 and 100000000 tinybars (1 HBAR)`)
  }
  return amount
}

export async function paymentRequired(url: string, config: { payTo: string; amount: string },
  support: Awaited<ReturnType<typeof getHederaSupport>>, description: string,
  extensions?: Record<string, unknown>): Promise<PaymentRequired> {
  const requirement = await new ExactHederaScheme().enhancePaymentRequirements({
    scheme: support.scheme, network: support.network, asset: '0.0.0', amount: config.amount,
    payTo: config.payTo, maxTimeoutSeconds: 120, extra: {},
  }, support, [])
  return {
    x402Version: 2, error: 'PAYMENT-SIGNATURE header is required',
    resource: { url, description, mimeType: 'application/json' }, accepts: [requirement],
    ...(extensions ? { extensions } : {}),
  }
}
