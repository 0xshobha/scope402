import { Hono } from 'hono'
import { scans } from './scans.js'

export const app = new Hono()

app.get('/health', (c) => c.json({ ok: true, service: 'auditlab' }))
app.route('/v1/scans', scans)
