import assert from 'node:assert/strict'
import { test } from 'node:test'
import { selectHederaSupport } from '../src/blocky.js'

const hedera = {
  scheme: 'exact', network: 'hedera:testnet', x402Version: 2,
  extra: { feePayer: '0.0.12345' },
}

test('selects exact Hedera testnet v2 among unrelated entries', () => {
  assert.deepEqual(selectHederaSupport({ kinds: [
    null,
    { ...hedera, network: 'eip155:80002' },
    { ...hedera, network: 'hedera:mainnet' },
    { ...hedera, x402Version: 1 },
    { ...hedera, scheme: 'upto' },
    hedera,
  ] }), hedera)
})

test('rejects missing support and malformed responses', () => {
  for (const body of [null, {}, { kinds: {} }, { kinds: [] },
    { kinds: [{ ...hedera, x402Version: '2' }] }]) {
    assert.throws(() => selectHederaSupport(body), /Blocky402/)
  }
})

test('requires a non-empty string fee payer', () => {
  for (const extra of [undefined, null, {}, { feePayer: '' },
    { feePayer: '   ' }, { feePayer: 123 }]) {
    assert.throws(() => selectHederaSupport({ kinds: [{ ...hedera, extra }] }), /feePayer/)
  }
})
