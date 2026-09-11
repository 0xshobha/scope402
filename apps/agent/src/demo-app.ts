import { Hono } from 'hono'
import type { Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { isIP } from 'node:net'
import { DemoRunError, DemoRunService } from './demo-runs.js'
import type { DemoActionName } from './capability-demo.js'
import type { TesseraActionName } from './tessera-capability.js'
import type { TesseraRunService } from './tessera-runs.js'
import type { TesseraLocation } from './tessera-purchase.js'

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
  trustedProxy: TrustedProxy = 'none', tessera?: TesseraRunService) {
  const app = new Hono()
  app.use('*', cors({
    origin: (origin) => allowedOrigins.has(origin) ? origin : '',
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    maxAge: 600,
  }))
  app.use('/demo/*', bodyLimit({ maxSize: 2_048 }))
  app.use('/tessera/*', bodyLimit({ maxSize: 2_048 }))
  app.use('/demo/*', async (c, next) => {
    await next()
    c.header('Cache-Control', 'no-store')
  })
  app.use('/tessera/*', async (c, next) => {
    await next()
    c.header('Cache-Control', 'no-store')
  })
  app.get('/health', (c) => c.json({ ok: true, service: 'scope402-demo-agent',
    mode: 'hedera-testnet-only', features: { auditlab: true, tessera: Boolean(tessera),
      tessera_worlds: Boolean(tessera), tessera_missions: Boolean(tessera) },
    contracts: { tessera_runs: tessera ? 4 : 0 } }))
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
  app.post('/tessera/runs', async (c) => {
    try {
      if (!tessera) throw new DemoRunError('TESSERA_UNAVAILABLE', 404, 'Tessera agent is not configured')
      let value: unknown
      try {
        const body = await c.req.text()
        value = body.trim() ? JSON.parse(body) : {}
      } catch {
        throw new DemoRunError('INVALID_REQUEST', 400, 'Expected valid JSON')
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new DemoRunError('INVALID_REQUEST', 400, 'Expected a JSON object')
      }
      const input = value as Record<string, unknown>
      const keys = Object.keys(input).sort()
      if (!['', 'canvas_id', 'canvas_id,location', 'canvas_id,location,slot',
        'canvas_id,slot', 'location', 'location,slot', 'slot'].includes(keys.join(',')) ||
          (input.slot !== undefined && (!Number.isSafeInteger(input.slot) || Number(input.slot) < 0 ||
            Number(input.slot) >= 16)) ||
          (input.canvas_id !== undefined && (typeof input.canvas_id !== 'string' ||
            !/^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/.test(input.canvas_id))) ||
          (input.location !== undefined && (!input.location || typeof input.location !== 'object' ||
            Array.isArray(input.location) ||
            Object.keys(input.location as object).sort().join(',') !== 'latitude,longitude' ||
            typeof (input.location as Record<string, unknown>).latitude !== 'number' ||
            !Number.isFinite((input.location as Record<string, number>).latitude) ||
            (input.location as Record<string, number>).latitude < -85 ||
            (input.location as Record<string, number>).latitude > 85 ||
            typeof (input.location as Record<string, unknown>).longitude !== 'number' ||
            !Number.isFinite((input.location as Record<string, number>).longitude) ||
            (input.location as Record<string, number>).longitude < -180 ||
            (input.location as Record<string, number>).longitude > 180))) {
        throw new DemoRunError('INVALID_REQUEST', 400,
          'Tessera run creation accepts only a safe canvas_id, optional slot, and geographic location')
      }
      return c.json(await tessera.create(clientIp(c.req.header('cf-connecting-ip'), trustedProxy),
        input.slot === undefined ? undefined : Number(input.slot),
        input.canvas_id === undefined ? 'main' : input.canvas_id,
        input.location === undefined ? undefined : input.location as TesseraLocation), 202)
    } catch (error) {
      return demoError(c, error)
    }
  })
  app.get('/tessera/runs/:runId', (c) => {
    try {
      if (!tessera) throw new DemoRunError('TESSERA_UNAVAILABLE', 404, 'Tessera agent is not configured')
      return c.json(tessera.get(c.req.param('runId'), bearer(c.req.header('Authorization'))))
    } catch (error) {
      return demoError(c, error)
    }
  })
  app.post('/tessera/runs/:runId/approve', async (c) => {
    try {
      if (!tessera) throw new DemoRunError('TESSERA_UNAVAILABLE', 404, 'Tessera agent is not configured')
      const body = await c.req.text()
      if (body.trim() && body.trim() !== '{}') {
        throw new DemoRunError('INVALID_REQUEST', 400, 'Tessera approval accepts no payment fields')
      }
      return c.json(await tessera.approve(c.req.param('runId'), bearer(c.req.header('Authorization'))))
    } catch (error) {
      return demoError(c, error)
    }
  })
  app.post('/tessera/runs/:runId/paint', async (c) => {
    try {
      if (!tessera) throw new DemoRunError('TESSERA_UNAVAILABLE', 404, 'Tessera agent is not configured')
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
      const keys = Object.keys(body).sort()
      if (keys.join(',') !== 'color,request_id,x,y' ||
          typeof body.request_id !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.request_id) ||
          !Number.isSafeInteger(body.x) || !Number.isSafeInteger(body.y) ||
          Number(body.x) < 0 || Number(body.x) >= 32 ||
          Number(body.y) < 0 || Number(body.y) >= 32 ||
          typeof body.color !== 'string' || !/^#[0-9A-F]{6}$/.test(body.color)) {
        throw new DemoRunError('INVALID_REQUEST', 400,
          'Paint accepts only a request_id, integer canvas coordinate, and uppercase hex palette color')
      }
      return c.json(await tessera.paint(c.req.param('runId'),
        bearer(c.req.header('Authorization')), body.request_id,
        { x: Number(body.x), y: Number(body.y), color: body.color }))
    } catch (error) {
      return demoError(c, error)
    }
  })
  app.post('/tessera/runs/:runId/mission', async (c) => {
    try {
      if (!tessera) throw new DemoRunError('TESSERA_UNAVAILABLE', 404, 'Tessera agent is not configured')
      const body = await c.req.text()
      if (body.trim() && body.trim() !== '{}') {
        throw new DemoRunError('INVALID_REQUEST', 400,
          'The hosted mission accepts no caller-controlled payment, authority, or pixel fields')
      }
      return c.json(await tessera.mission(c.req.param('runId'),
        bearer(c.req.header('Authorization'))))
    } catch (error) {
      return demoError(c, error)
    }
  })
  app.post('/tessera/runs/:runId/actions/:action', async (c) => {
    try {
      if (!tessera) throw new DemoRunError('TESSERA_UNAVAILABLE', 404, 'Tessera agent is not configured')
      const body = await c.req.text()
      if (body.trim() && body.trim() !== '{}') {
        throw new DemoRunError('INVALID_REQUEST', 400,
          'Tessera actions accept no caller-controlled authority or pixel fields')
      }
      const action = c.req.param('action')
      if (!['delegate', 'place-outside', 'wrong-key', 'place-inside', 'replay', 'expire'].includes(action)) {
        throw new DemoRunError('DEMO_ACTION_NOT_FOUND', 404, 'Tessera action was not found')
      }
      return c.json(await tessera.action(c.req.param('runId'),
        bearer(c.req.header('Authorization')), action as TesseraActionName))
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
