import { Hono } from 'hono'
import { auditLabDiscovery } from './discovery.js'
import { delegations } from './delegations.js'
import { leaseControls } from './lease-controls.js'
import { scans } from './scans.js'
import { plots } from './plots.js'
import { tesseraCanvas } from './merchants/tessera/canvas.js'
import { tesseraTools } from './merchants/tessera/tools.js'
import { tools } from './tools.js'

export const app = new Hono()

app.get('/health', (c) => c.json({ ok: true, service: 'auditlab' }))
app.get('/.well-known/scope402', (c) => {
  c.header('Cache-Control', 'public, max-age=300')
  return c.json(auditLabDiscovery)
})
app.route('/v1/leases', leaseControls)
app.route('/v1/leases', delegations)
app.route('/v1/scans', scans)
app.route('/v1/plots', plots)
app.route('/v1/canvas', tesseraCanvas)
app.route('/v1/tools', tools)
app.route('/v1/tools', tesseraTools)
