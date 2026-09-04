import assert from 'node:assert/strict'
import { test } from 'node:test'
import { selectPayment } from '../src/policy.js'

const url = 'http://127.0.0.1:3000/v1/scans'
const terms = { scheme: 'exact', network: 'hedera:testnet', asset: '0.0.0',
  amount: '100000', payTo: '0.0.12345', maxTimeoutSeconds: 120, extra: { feePayer: '0.0.67890' } }
const required = { x402Version: 2, resource: { url }, accepts: [terms] }

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

test('refuses self-payment and another resource', () => {
  assert.throws(() => selectPayment(required, url, '0.0.12345', '0.0.12345', '100000'))
  assert.throws(() => selectPayment(required, `${url}/other`, '0.0.12345', '0.0.54321', '100000'))
})
