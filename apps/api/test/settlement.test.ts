import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hashscanUrl, settlementReceipt, verifiedPayer } from '../src/settlement.js'

test('verification requires boolean true and an identified payer', () => {
  for (const body of [null, {}, { isValid: false }, { isValid: 'true' }, { isValid: true }]) {
    assert.throws(() => verifiedPayer(body))
  }
  assert.equal(verifiedPayer({ isValid: true, payer: '0.0.12345' }), '0.0.12345')
})

test('settlement requires explicit success and matching receipt fields', () => {
  const tx = '0.0.67890@1700000000.123456789'
  const receipt = { success: true, transaction: tx, network: 'hedera:testnet', payer: '0.0.12345' }
  assert.deepEqual(settlementReceipt(receipt, receipt.payer, tx), receipt)
  for (const change of [{ success: false }, { success: 'true' }, { transaction: '' },
    { transaction: `${tx}0` }, { network: 'hedera:mainnet' }, { payer: '0.0.11111' }]) {
    assert.throws(() => settlementReceipt({ ...receipt, ...change }, receipt.payer, tx))
  }
})

test('formats Hedera IDs as HashScan paths and rejects malformed IDs', () => {
  assert.equal(hashscanUrl('0.0.67890@1700000000.123456789'),
    'https://hashscan.io/testnet/transaction/0.0.67890-1700000000-123456789')
  for (const value of ['', '0xfake', 'https://example.com', '0.0.1@abc.def']) assert.throws(() => hashscanUrl(value))
})
