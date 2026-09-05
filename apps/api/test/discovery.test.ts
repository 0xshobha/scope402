import assert from 'node:assert/strict'
import { test } from 'node:test'
import { app } from '../src/app.js'
import { auditLabDiscovery } from '../src/discovery.js'

test('publishes the AuditLab paid resource and leased tool', async () => {
  const response = await app.request('/.well-known/scope402')
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/)
  assert.equal(response.headers.get('cache-control'), 'public, max-age=300')
  assert.deepEqual(await response.json(), auditLabDiscovery)
  assert.deepEqual(auditLabDiscovery.resources.repository_scan,
    { method: 'POST', path: '/v1/scans' })
  assert.deepEqual(auditLabDiscovery.resources.tessera_plot,
    { method: 'POST', path: '/v1/plots' })
  assert.equal(auditLabDiscovery.authorization.tools[0].id, 'finding_details')
})
