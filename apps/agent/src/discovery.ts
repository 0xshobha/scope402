function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('AuditLab discovery document is malformed')
  }
  return value as Record<string, unknown>
}

function discovery(value: unknown) {
  const document = record(value)
  const service = record(document.service)
  const payment = record(document.payment)
  const resources = record(document.resources)
  if (service.id !== 'auditlab' || document.version !== 1 ||
      document.network !== 'hedera:testnet' || payment.protocol !== 'x402' ||
      payment.version !== 2 || payment.facilitator !== 'blocky402') {
    throw new Error('AuditLab discovery document does not advertise the expected service')
  }
  return resources
}

function selectPostResource(value: unknown, baseUrl: URL, name: string) {
  const resourceDefinition = record(discovery(value)[name])
  if (resourceDefinition.method !== 'POST' || typeof resourceDefinition.path !== 'string' ||
      !resourceDefinition.path.startsWith('/') || resourceDefinition.path.startsWith('//')) {
    throw new Error(`AuditLab discovery document does not advertise ${name}`)
  }
  const resource = new URL(resourceDefinition.path, baseUrl)
  if (resource.origin !== baseUrl.origin) {
    throw new Error('Discovered paid resource must stay on the AuditLab origin')
  }
  return resource
}

export function selectScanResource(value: unknown, baseUrl: URL) {
  return selectPostResource(value, baseUrl, 'repository_scan')
}

export function selectPlotResource(value: unknown, baseUrl: URL) {
  return selectPostResource(value, baseUrl, 'tessera_plot')
}

async function discover(baseUrl: URL, request: typeof fetch) {
  const response = await request(new URL('/.well-known/scope402', baseUrl), {
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`AuditLab discovery returned HTTP ${response.status}`)
  return response.json()
}

export async function discoverScanResource(baseUrl: URL, request: typeof fetch = fetch) {
  return selectScanResource(await discover(baseUrl, request), baseUrl)
}

export async function discoverPlotResource(baseUrl: URL, request: typeof fetch = fetch) {
  return selectPlotResource(await discover(baseUrl, request), baseUrl)
}
