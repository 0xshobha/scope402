function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('AuditLab discovery document is malformed')
  }
  return value as Record<string, unknown>
}

export function selectScanResource(value: unknown, baseUrl: URL) {
  const document = record(value)
  const service = record(document.service)
  const payment = record(document.payment)
  const resources = record(document.resources)
  const scan = record(resources.repository_scan)
  if (service.id !== 'auditlab' || document.version !== 1 ||
      document.network !== 'hedera:testnet' || payment.protocol !== 'x402' ||
      payment.version !== 2 || payment.facilitator !== 'blocky402' ||
      scan.method !== 'POST' || typeof scan.path !== 'string' ||
      !scan.path.startsWith('/') || scan.path.startsWith('//')) {
    throw new Error('AuditLab discovery document does not advertise the expected paid scan')
  }
  const resource = new URL(scan.path, baseUrl)
  if (resource.origin !== baseUrl.origin) {
    throw new Error('Discovered scan resource must stay on the AuditLab origin')
  }
  return resource
}

export async function discoverScanResource(baseUrl: URL, request: typeof fetch = fetch) {
  const response = await request(new URL('/.well-known/scope402', baseUrl), {
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`AuditLab discovery returned HTTP ${response.status}`)
  return selectScanResource(await response.json(), baseUrl)
}
