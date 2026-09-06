import assert from 'node:assert/strict'
import { test } from 'node:test'
import { app } from '../src/app.js'

test('GET /health returns a publicly readable AuditLab health response', async () => {
  const response = await app.request('/health', { headers: { Origin: 'https://scope402.onrender.com' } })

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/)
  assert.equal(response.headers.get('access-control-allow-origin'), '*')
  assert.deepEqual(await response.json(), { ok: true, service: 'auditlab' })
})
