import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkReadiness, type ReadinessDependencies } from '../src/readiness.js'

const succeeds = async () => {}
const fails = async () => { throw new Error('sensitive upstream detail') }

function dependencies(overrides: Partial<ReadinessDependencies> = {}): ReadinessDependencies {
  return {
    database: succeeds,
    blocky402: succeeds,
    capabilityIssuer: succeeds,
    ...overrides,
  }
}

test('readiness succeeds only when every payment dependency is usable', async () => {
  assert.deepEqual(await checkReadiness(dependencies()), {
    ok: true,
    service: 'scope402-api',
    network: 'hedera:testnet',
    dependencies: {
      database: 'ok',
      blocky402: 'ok',
      capability_issuer: 'ok',
    },
  })
})

test('readiness reports every failed dependency without leaking error details', async () => {
  const result = await checkReadiness(dependencies({ database: fails, blocky402: fails }))

  assert.deepEqual(result, {
    ok: false,
    service: 'scope402-api',
    network: 'hedera:testnet',
    dependencies: {
      database: 'unavailable',
      blocky402: 'unavailable',
      capability_issuer: 'ok',
    },
  })
  assert.doesNotMatch(JSON.stringify(result), /sensitive upstream detail/)
})
