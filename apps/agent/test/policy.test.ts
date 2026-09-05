import assert from 'node:assert/strict'
import { test } from 'node:test'
import { selectPayment } from '../src/policy.js'

const url = 'http://127.0.0.1:3000/v1/scans'
const quoteUrl = `${url}?quote_id=123e4567-e89b-42d3-a456-426614174000`
const terms = { scheme: 'exact', network: 'hedera:testnet', asset: '0.0.0',
  amount: '100000', payTo: '0.0.12345', maxTimeoutSeconds: 120, extra: { feePayer: '0.0.67890' } }
const required = { x402Version: 2, resource: { url: quoteUrl }, accepts: [terms] }

test('accepts the intended merchant and bounded testnet HBAR amount', () => {
  assert.deepEqual(selectPayment(required, url, '0.0.12345', '0.0.54321', '100000').terms, terms)
})

test('refuses changes to the network, asset, payee, or budget', () => {
  for (const change of [{ network: 'hedera:mainnet' }, { asset: '0.0.429274' },
    { payTo: '0.0.11111' }, { amount: '100001' }, { amount: '-1' }, { extra: {} }]) {
    assert.throws(() => selectPayment({ ...required, accepts: [{ ...terms, ...change }] },
      url, '0.0.12345', '0.0.54321', '100000'))
  }
})

test('refuses mainnet, non-HBAR, wrong merchant, excessive price, and invalid fee payer individually', () => {
  const changes = [
    { network: 'hedera:mainnet' },
    { asset: '0.0.429274' },
    { payTo: '0.0.99999' },
    { amount: '150001' },
    { extra: { feePayer: 'not-an-account' } },
  ]
  for (const change of changes) {
    assert.throws(() => selectPayment({ ...required, accepts: [{ ...terms, ...change }] },
      url, '0.0.12345', '0.0.54321', '150000'))
  }
})

test('refuses changed resource origins and paths', () => {
  for (const resourceUrl of [
    'https://evil.example/v1/scans?quote_id=123e4567-e89b-42d3-a456-426614174000',
    'http://127.0.0.1:3000/v1/other?quote_id=123e4567-e89b-42d3-a456-426614174000',
  ]) {
    assert.throws(() => selectPayment({ ...required, resource: { url: resourceUrl } },
      url, '0.0.12345', '0.0.54321', '150000'))
  }
})

test('refuses self-payment and another resource', () => {
  assert.throws(() => selectPayment(required, url, '0.0.12345', '0.0.12345', '100000'))
  assert.throws(() => selectPayment(required, `${url}/other`, '0.0.12345', '0.0.54321', '100000'))
  assert.throws(() => selectPayment({ ...required, resource: { url } }, url,
    '0.0.12345', '0.0.54321', '100000'))
})
