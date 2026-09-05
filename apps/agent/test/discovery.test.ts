import assert from 'node:assert/strict'
import { test } from 'node:test'
import { discoverScanResource, selectScanResource } from '../src/discovery.js'

const document = {
  service: { id: 'auditlab', name: 'AuditLab' }, version: 1,
  network: 'hedera:testnet',
  payment: { protocol: 'x402', version: 2, facilitator: 'blocky402' },
  resources: { repository_scan: { method: 'POST', path: '/v1/scans' } },
}

test('selects the same-origin paid scan advertised by AuditLab', async () => {
  const base = new URL('https://auditlab.example')
  assert.equal(selectScanResource(document, base).href, 'https://auditlab.example/v1/scans')
  const request = (async (input) => {
    assert.equal(String(input), 'https://auditlab.example/.well-known/scope402')
    return new Response(JSON.stringify(document), { status: 200 })
  }) as typeof fetch
  assert.equal((await discoverScanResource(base, request)).href,
    'https://auditlab.example/v1/scans')
})

test('rejects malformed, incompatible, and cross-origin discovery', () => {
  for (const value of [null, {}, { ...document, network: 'hedera:mainnet' },
    { ...document, payment: { ...document.payment, version: 1 } },
    { ...document, resources: { repository_scan: { method: 'GET', path: '/v1/scans' } } },
    { ...document, resources: { repository_scan: { method: 'POST', path: '//evil.example/scan' } } }]) {
    assert.throws(() => selectScanResource(value, new URL('https://auditlab.example')), /discovery|expected/)
  }
})
