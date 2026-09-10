import { probeHederaSupport } from './blocky.js'
import { database } from './db.js'
import { merchantConfig } from './payment-offer.js'
import { loadServiceKey } from './scope402/lease.js'

type Check = () => Promise<void>

export type ReadinessDependencies = {
  database: Check
  blocky402: Check
  capabilityIssuer: Check
}

const defaultDependencies: ReadinessDependencies = {
  database: async () => { await database().query('SELECT 1') },
  blocky402: async () => {
    const support = await probeHederaSupport()
    if (support.network !== 'hedera:testnet' || support.scheme !== 'exact' || support.x402Version !== 2) {
      throw new Error('Required Hedera payment support is unavailable')
    }
  },
  capabilityIssuer: async () => {
    merchantConfig()
    await loadServiceKey()
  },
}

export type ReadinessResult = {
  ok: boolean
  service: 'scope402-api'
  network: 'hedera:testnet'
  dependencies: {
    database: 'ok' | 'unavailable'
    blocky402: 'ok' | 'unavailable'
    capability_issuer: 'ok' | 'unavailable'
  }
}

export async function checkReadiness(
  dependencies: ReadinessDependencies = defaultDependencies,
): Promise<ReadinessResult> {
  const [databaseResult, blockyResult, issuerResult] = await Promise.allSettled([
    dependencies.database(),
    dependencies.blocky402(),
    dependencies.capabilityIssuer(),
  ])
  const statuses = {
    database: databaseResult.status === 'fulfilled' ? 'ok' : 'unavailable',
    blocky402: blockyResult.status === 'fulfilled' ? 'ok' : 'unavailable',
    capability_issuer: issuerResult.status === 'fulfilled' ? 'ok' : 'unavailable',
  } as const

  return {
    ok: Object.values(statuses).every((status) => status === 'ok'),
    service: 'scope402-api',
    network: 'hedera:testnet',
    dependencies: statuses,
  }
}
