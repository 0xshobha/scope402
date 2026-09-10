import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { app } from '../src/app.js'
import { auditLabDiscovery } from '../src/discovery.js'

test('publishes the AuditLab paid resource and leased tool', async () => {
  const response = await app.request('/.well-known/scope402', {
    headers: { Origin: 'https://scope402.onrender.com' },
  })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/)
  assert.equal(response.headers.get('cache-control'), 'public, max-age=300')
  assert.equal(response.headers.get('access-control-allow-origin'), '*')
  assert.deepEqual(await response.json(), auditLabDiscovery)
  assert.deepEqual(auditLabDiscovery.resources.repository_scan,
    { method: 'POST', path: '/v1/scans' })
  assert.deepEqual(auditLabDiscovery.resources.tessera_plot,
    { method: 'POST', path: '/v1/plots' })
  assert.deepEqual(auditLabDiscovery.resources.tessera_canvas,
    { method: 'GET', path: '/v1/canvas' })
  assert.deepEqual(auditLabDiscovery.resources.tessera_canvases,
    { method: 'GET', path: '/v1/canvases' })
  assert.deepEqual(auditLabDiscovery.resources.tessera_canvas_by_id,
    { method: 'GET', path_template: '/v1/canvas/{canvas_id}' })
  assert.equal(auditLabDiscovery.authorization.tools[0].id, 'finding_details')
  assert.equal(auditLabDiscovery.authorization.tools[1].id, 'place_pixel')
})

test('keeps the published Tessera OpenAPI routes aligned with discovery', async () => {
  const contract = JSON.parse(await readFile(
    new URL('../../web/public/openapi.json', import.meta.url), 'utf8')) as {
      paths: Record<string, unknown>
      components: { schemas: Record<string, { pattern?: string; properties?: Record<string, unknown> }> }
  }
  const paths = contract.paths
  for (const path of ['/health', '/ready', '/.well-known/scope402', '/v1/plots', '/v1/canvas',
    '/v1/canvas/{canvas_id}', '/v1/canvases', '/v1/tools/place_pixel',
    '/v1/leases/{lease_id}/delegations']) {
    assert.ok(paths[path], `OpenAPI is missing ${path}`)
  }
  assert.equal(auditLabDiscovery.resources.tessera_canvases.path, '/v1/canvases')
  assert.equal(auditLabDiscovery.resources.tessera_canvas_by_id.path_template,
    '/v1/canvas/{canvas_id}')
  const canvasId = contract.components.schemas.CanvasId
  assert.equal(new RegExp(canvasId.pattern!).test('agent-garden'), true)
  assert.equal(new RegExp(canvasId.pattern!).test('../escape'), false)
  const plot = paths['/v1/plots'] as { post: { requestBody: { content: {
    'application/json': { schema: { properties: Record<string, unknown> }
  } } } } }
  assert.ok(plot.post.requestBody.content['application/json'].schema.properties.slot)
})
