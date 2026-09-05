export const auditLabDiscovery = {
  service: { id: 'auditlab', name: 'AuditLab' },
  version: 1,
  network: 'hedera:testnet',
  payment: { protocol: 'x402', version: 2, facilitator: 'blocky402' },
  resources: {
    repository_scan: { method: 'POST', path: '/v1/scans' },
    tessera_plot: { method: 'POST', path: '/v1/plots' },
  },
  authorization: {
    scheme: 'scope402-tool-lease',
    tools: [{ id: 'finding_details', method: 'POST', path: '/v1/tools/finding_details' }],
  },
} as const
