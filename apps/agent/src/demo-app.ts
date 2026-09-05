import { Hono } from 'hono'
import type { Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { isIP } from 'node:net'
import { DemoRunError, DemoRunService } from './demo-runs.js'
import type { DemoActionName } from './capability-demo.js'

function bearer(value: string | undefined) {
  return value?.startsWith('Bearer ') ? value.slice(7) : ''
}

export type TrustedProxy = 'none' | 'render'

function clientIp(cloudflare: string | undefined, trustedProxy: TrustedProxy) {
  if (trustedProxy !== 'render') return 'unknown'
  const address = cloudflare?.trim() ?? ''
  return isIP(address) ? address : 'unknown'
}

export function createDemoAgentApp(service: DemoRunService, allowedOrigins: Set<string>,
  trustedProxy: TrustedProxy = 'none') {
  const app = new Hono()
  app.use('*', cors({
    origin: (origin) => allowedOrigins.has(origin) ? origin : '',
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    maxAge: 600,
  }))
  app.use('/demo/*', bodyLimit({ maxSize: 2_048 }))
  app.use('/demo/*', async (c, next) => {
    await next()
    c.header('Cache-Control', 'no-store')
  })
  app.get('/health', (c) => c.json({ ok: true, service: 'scope402-demo-agent',
    mode: 'hedera-testnet-only' }))
  app.post('/demo/runs', async (c) => {
    try {
      let value: unknown
      try {
        value = await c.req.json()
      } catch {
        throw new DemoRunError('INVALID_REQUEST', 400, 'Expected valid JSON')
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new DemoRunError('INVALID_REQUEST', 400, 'Expected a JSON object')
      }
      const body = value as Record<string, unknown>
      if (Object.keys(body).length !== 1 || typeof body.repo_url !== 'string') {
        throw new DemoRunError('INVALID_REQUEST', 400, 'Only repo_url is accepted')
      }
      return c.json(await service.create(body.repo_url,
        clientIp(c.req.header('cf-connecting-ip'), trustedProxy)), 202)
    } catch (error) {
      return demoError(c, error)
    }
  })
  app.get('/demo/runs/:runId', (c) => {
    try {
      return c.json(service.get(c.req.param('runId'), bearer(c.req.header('Authorization'))))
    } catch (error) {
      return demoError(c, error)
    }
  })
  app.post('/demo/runs/:runId/approve', async (c) => {
    try {
      const body = await c.req.text()
      if (body.trim() && body.trim() !== '{}') {
        throw new DemoRunError('INVALID_REQUEST', 400, 'Approval accepts no payment fields')
      }
      return c.json(await service.approve(c.req.param('runId'),
        bearer(c.req.header('Authorization'))))
    } catch (error) {
      return demoError(c, error)
    }
  })
  app.post('/demo/runs/:runId/actions/:action', async (c) => {
    try {
      const body = await c.req.text()
      if (body.trim() && body.trim() !== '{}') {
        throw new DemoRunError('INVALID_REQUEST', 400, 'Capability actions accept no caller-controlled fields')
      }
      const action = c.req.param('action')
      if (!['wrong-key', 'legitimate', 'replay', 'expire'].includes(action)) {
        throw new DemoRunError('DEMO_ACTION_NOT_FOUND', 404, 'Capability action was not found')
      }
      return c.json(await service.action(c.req.param('runId'),
        bearer(c.req.header('Authorization')), action as DemoActionName))
    } catch (error) {
      return demoError(c, error)
    }
  })
  return app
}

function demoError(c: Context, error: unknown) {
  if (error instanceof DemoRunError) {
    return c.json({ error: error.code, message: error.message }, error.status)
  }
  return c.json({ error: 'DEMO_AGENT_ERROR', message: 'Hosted demo-agent request failed' }, 502)
}
