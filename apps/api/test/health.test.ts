import assert from 'node:assert/strict'
import { test } from 'node:test'
import { app } from '../src/app.js'

test('GET /health returns the AuditLab health response', async () => {
  const response = await app.request('/health')

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/)
  assert.deepEqual(await response.json(), { ok: true, service: 'auditlab' })
})
