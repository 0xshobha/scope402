type HederaSupport = {
  scheme: 'exact'
  network: 'hedera:testnet'
  x402Version: 2
  extra: { feePayer: string }
}

let cached: { value: HederaSupport; expiresAt: number } | undefined
let inFlight: Promise<HederaSupport> | undefined
const supportTtlMs = 5 * 60_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function selectHederaSupport(body: unknown): HederaSupport {
  if (!isRecord(body) || !Array.isArray(body.kinds)) {
    throw new Error('Blocky402 /supported returned invalid kinds')
  }

  for (const kind of body.kinds) {
    if (!isRecord(kind) || kind.scheme !== 'exact' ||
        kind.network !== 'hedera:testnet' || kind.x402Version !== 2) continue

    if (!isRecord(kind.extra) || typeof kind.extra.feePayer !== 'string' ||
        !kind.extra.feePayer.trim()) {
      throw new Error('Blocky402 Hedera support is missing a non-empty feePayer')
    }

    return {
      scheme: 'exact', network: 'hedera:testnet', x402Version: 2,
      extra: { feePayer: kind.extra.feePayer },
    }
  }

  throw new Error('Blocky402 does not advertise exact Hedera testnet x402 v2 support')
}

async function fetchHederaSupport(): Promise<HederaSupport> {
  const response = await fetch('https://api.testnet.blocky402.com/supported', {
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  })
  if (!response.ok) {
    throw new Error(`Blocky402 /supported returned HTTP ${response.status}`)
  }
  return selectHederaSupport(await response.json())
}

export async function getHederaSupport(): Promise<HederaSupport> {
  if (cached && cached.expiresAt > Date.now()) return cached.value
  if (inFlight) return inFlight
  const lastKnown = cached?.value
  inFlight = fetchHederaSupport().then((value) => {
    cached = { value, expiresAt: Date.now() + supportTtlMs }
    return value
  }).catch((error) => {
    if (lastKnown) return lastKnown
    throw error
  }).finally(() => { inFlight = undefined })
  return inFlight
}

export function clearHederaSupportCache() {
  cached = undefined
  inFlight = undefined
}
