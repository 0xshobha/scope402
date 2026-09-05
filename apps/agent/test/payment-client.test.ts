import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types'
import { PrivateKey } from '@x402/hedera'
import { ExactPaymentDeliveryError, executeExactHederaPayment,
  type PreparedExactPayment } from '../src/payment-client.js'

test('ambiguous delivery reuses one signed Hedera transaction across later recovery calls', async () => {
  const terms = {
    scheme: 'exact', network: 'hedera:testnet', asset: '0.0.0', amount: '56000',
    payTo: '0.0.12345', maxTimeoutSeconds: 120, extra: { feePayer: '0.0.67890' },
  } as PaymentRequirements
  const required = {
    x402Version: 2, resource: { url: 'https://auditlab.example/v1/plots?quote_id=quote' },
    accepts: [terms],
  } as PaymentRequired
  const prepared: PreparedExactPayment = {
    paymentUrl: required.resource.url, requestBody: '{}', required, terms,
  }
  const headers: string[] = []
  const request = (async (_input, init) => {
    headers.push(new Headers(init?.headers).get('PAYMENT-SIGNATURE') ?? '')
    throw new TypeError('connection reset after request write')
  }) as typeof fetch
  const config = { payer: '0.0.54321', merchant: '0.0.12345',
    payerPrivateKey: PrivateKey.generateECDSA().toString() }
  const execute = () => executeExactHederaPayment(config, prepared, new Set(['PLOT_RETRYABLE']),
    (value) => value, request, async () => {})

  await assert.rejects(execute(), ExactPaymentDeliveryError)
  await assert.rejects(execute(), ExactPaymentDeliveryError)
  assert.equal(headers.length, 6)
  assert.ok(headers[0])
  assert.equal(new Set(headers).size, 1)
  assert.equal(typeof prepared.paymentSignature, 'string')
})
