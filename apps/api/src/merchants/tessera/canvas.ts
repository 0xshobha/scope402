import { Hono } from 'hono'
import { database } from '../../db.js'
import { TESSERA_PALETTE } from './palette.js'
import { rootCanvasRegion, TESSERA_CANVAS_ID, TESSERA_CANVAS_SIZE } from './resource.js'

export const tesseraCanvas = new Hono()
tesseraCanvas.get('/', async (c) => {
  try {
    const [pixels, regions] = await Promise.all([
      database().query(
        `SELECT x, y, color, extract(epoch from updated_at)::bigint AS updated_at
         FROM tessera_pixels WHERE canvas_id = $1 ORDER BY y, x`,
        [TESSERA_CANVAS_ID],
      ),
      database().query(
        `SELECT slot.slot, job.lease_id,
                extract(epoch from lease.expires_at)::bigint AS expires_at,
                lease.max_calls - lease.used_calls - lease.reserved_calls AS remaining_calls,
                lease.expires_at > now() AS active
         FROM tessera_slots AS slot
         JOIN plot_jobs AS job ON job.quote_id = slot.quote_id AND job.status = 'complete'
         JOIN tool_leases AS lease ON lease.lease_id = job.lease_id
         WHERE slot.canvas_id = $1 AND slot.status = 'allocated'
         ORDER BY slot.slot`,
        [TESSERA_CANVAS_ID],
      ),
    ])
    c.header('Cache-Control', 'no-store')
    return c.json({ canvas_id: TESSERA_CANVAS_ID, width: TESSERA_CANVAS_SIZE,
      height: TESSERA_CANVAS_SIZE, palette: TESSERA_PALETTE,
      pixels: pixels.rows.map((row) => ({ x: Number(row.x), y: Number(row.y),
        color: String(row.color), updated_at: Number(row.updated_at) })),
      regions: regions.rows.map((row) => ({ slot: Number(row.slot),
        ...rootCanvasRegion(Number(row.slot)), lease_id: String(row.lease_id),
        expires_at: Number(row.expires_at), remaining_calls: Number(row.remaining_calls),
        active: Boolean(row.active), status: row.active ? 'active' : 'expired' })) })
  } catch (error) {
    console.error(`Tessera canvas read failed: ${error instanceof Error ? error.message : 'unknown error'}`)
    return c.json({ error: 'CANVAS_UNAVAILABLE', message: 'Canvas state is temporarily unavailable' }, 503)
  }
})
