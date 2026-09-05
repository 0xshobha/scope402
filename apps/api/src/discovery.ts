export const auditLabDiscovery = {
  service: { id: 'auditlab', name: 'AuditLab' },
  version: 1,
  network: 'hedera:testnet',
  payment: { protocol: 'x402', version: 2, facilitator: 'blocky402' },
  resources: {
    repository_scan: { method: 'POST', path: '/v1/scans' },
    tessera_plot: { method: 'POST', path: '/v1/plots' },
    tessera_canvas: { method: 'GET', path: '/v1/canvas' },
  },
  authorization: {
    scheme: 'scope402-tool-lease',
    delegation: { method: 'POST', path_template: '/v1/leases/{lease_id}/delegations' },
    tools: [
      { id: 'finding_details', method: 'POST', path: '/v1/tools/finding_details' },
      { id: 'place_pixel', method: 'POST', path: '/v1/tools/place_pixel' },
    ],
  },
} as const
