import { PaymentRequiredV2Schema } from '@x402/core/schemas'

export function selectPayment(value: unknown, url: string, merchant: string, payer: string, limit: string) {
  if (!/^[1-9]\d*$/.test(limit) || BigInt(limit) > 100_000_000n) {
    throw new Error('MAX_PAYMENT_TINYBARS must be a positive integer at most 100000000')
  }
  if (merchant === payer) throw new Error('Payer and merchant must be separate accounts')
  const required = PaymentRequiredV2Schema.parse(value)
  const requested = new URL(url)
  const quoted = new URL(required.resource.url)
  if (quoted.origin !== requested.origin || quoted.pathname !== requested.pathname ||
      quoted.searchParams.size !== 1 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(quoted.searchParams.get('quote_id') ?? '')) {
    throw new Error('Payment resource is not a valid quote for the requested URL')
  }
  const terms = required.accepts.find((entry) => entry.scheme === 'exact' &&
    entry.network === 'hedera:testnet' && entry.asset === '0.0.0' && entry.payTo === merchant)
  if (!terms) throw new Error('No exact Hedera testnet HBAR payment to the configured merchant')
  if (!/^[1-9]\d*$/.test(terms.amount) || BigInt(terms.amount) > BigInt(limit)) {
    throw new Error('Payment exceeds the agent budget or has an invalid tinybar amount')
  }
  if (typeof terms.extra?.feePayer !== 'string' || !/^\d+\.\d+\.[1-9]\d*$/.test(terms.extra.feePayer)) {
    throw new Error('Missing or invalid facilitator fee payer')
  }
  return { required, paymentUrl: quoted, terms: { ...terms, network: 'hedera:testnet' as const, extra: terms.extra } }
}
