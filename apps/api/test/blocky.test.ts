import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clearHederaSupportCache, getHederaSupport, selectHederaSupport } from '../src/blocky.js'

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

test('caches support, deduplicates refreshes, and keeps the last known value', async (t) => {
  clearHederaSupportCache()
  let now = 1_000
  let calls = 0
  let unavailable = false
  const originalNow = Date.now
  const originalFetch = globalThis.fetch
  Date.now = () => now
  globalThis.fetch = (async () => {
    calls += 1
    if (unavailable) return new Response('{}', { status: 503 })
    return new Response(JSON.stringify({ kinds: [hedera] }), { status: 200 })
  }) as typeof fetch
  t.after(() => {
    Date.now = originalNow
    globalThis.fetch = originalFetch
    clearHederaSupportCache()
  })

  const [first, concurrent] = await Promise.all([getHederaSupport(), getHederaSupport()])
  assert.deepEqual(first, hedera)
  assert.deepEqual(concurrent, hedera)
  assert.equal(calls, 1)
  assert.deepEqual(await getHederaSupport(), hedera)
  assert.equal(calls, 1)

  now += 5 * 60_000 + 1
  unavailable = true
  assert.deepEqual(await getHederaSupport(), hedera)
  assert.equal(calls, 2)
})
