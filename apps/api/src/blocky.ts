type HederaSupport = {
  scheme: 'exact'
  network: 'hedera:testnet'
  x402Version: 2
  extra: { feePayer: string }
}

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

export async function getHederaSupport(): Promise<HederaSupport> {
  const response = await fetch('https://api.testnet.blocky402.com/supported', {
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  })
  if (!response.ok) {
    throw new Error(`Blocky402 /supported returned HTTP ${response.status}`)
  }
  return selectHederaSupport(await response.json())
}
