import { Hono } from 'hono'
import { leaseControls } from './lease-controls.js'
import { scans } from './scans.js'
import { tools } from './tools.js'

export const app = new Hono()

app.get('/health', (c) => c.json({ ok: true, service: 'auditlab' }))
app.route('/v1/leases', leaseControls)
app.route('/v1/scans', scans)
app.route('/v1/tools', tools)
