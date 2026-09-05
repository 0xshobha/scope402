import { Hono } from 'hono'
import { database } from './db.js'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export const leaseControls = new Hono()

leaseControls.post('/:leaseId/expire', async (c) => {
  if (process.env.ENABLE_DEMO_CONTROLS !== 'true') return c.notFound()
  const leaseId = c.req.param('leaseId')
  if (!uuid.test(leaseId)) return c.notFound()
  const result = await database().query(
    `UPDATE tool_leases SET expires_at = now() WHERE lease_id = $1 RETURNING lease_id`,
    [leaseId],
  )
  if (result.rowCount !== 1) return c.notFound()
  return c.json({ lease_id: leaseId, status: 'expired' })
})
