import { Hono } from 'hono'
import { database, type TransactionClient } from '../../db.js'
import { PaymentError } from '../../payment-error.js'
import { TESSERA_CANVAS_ID, TESSERA_CANVAS_SIZE, TESSERA_SLOT_COUNT,
  parseCanvasId } from './resource.js'

const DEFAULT_WORLD_LIMIT = 64

export function tesseraWorldLimit() {
  const configured = process.env.TESSERA_WORLD_LIMIT ?? String(DEFAULT_WORLD_LIMIT)
  if (!/^[1-9]\d*$/.test(configured) || Number(configured) > 100) {
    throw new Error('TESSERA_WORLD_LIMIT must be an integer between 1 and 100')
  }
  return Number(configured)
}

export function canvasDisplayName(canvasId: string) {
  parseCanvasId(canvasId)
  if (canvasId === TESSERA_CANVAS_ID) return 'Opal World'
  return canvasId.split('-').map((part) => part[0]!.toUpperCase() + part.slice(1)).join(' ')
}

async function reclaimAbandonedCanvas(client: TransactionClient) {
  const candidate = await client.query(
    `SELECT canvas.canvas_id
     FROM tessera_canvases AS canvas
     WHERE canvas.canvas_id <> $1
       AND canvas.created_at <= clock_timestamp() - interval '5 minutes'
       AND NOT EXISTS (
         SELECT 1 FROM tessera_pixels AS pixel WHERE pixel.canvas_id = canvas.canvas_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM tessera_pixel_events AS event WHERE event.canvas_id = canvas.canvas_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM tessera_slots AS slot
         WHERE slot.canvas_id = canvas.canvas_id AND (
           slot.status = 'allocated' OR
           (slot.status = 'pending' AND (
             slot.reservation_expires_at > clock_timestamp() OR EXISTS (
               SELECT 1 FROM payment_redemptions AS redemption
               WHERE redemption.quote_id = slot.quote_id AND (
                 redemption.status IN ('settlement_attempted', 'settlement_unknown', 'settled') OR
                 (redemption.status = 'verifying' AND
                   redemption.updated_at > clock_timestamp() - interval '3 minutes')
               )
             )
           ))
         )
       )
     ORDER BY canvas.created_at, canvas.canvas_id
     FOR UPDATE OF canvas SKIP LOCKED LIMIT 1`,
    [TESSERA_CANVAS_ID],
  )
  if (candidate.rowCount !== 1) return false
  const canvasId = String(candidate.rows[0].canvas_id)
  await client.query(`DELETE FROM tessera_slots WHERE canvas_id = $1`, [canvasId])
  await client.query(`DELETE FROM tessera_canvases WHERE canvas_id = $1`, [canvasId])
  return true
}

export async function ensureCanvas(client: TransactionClient, canvasId: string) {
  const id = parseCanvasId(canvasId)
  let exists = (await client.query(
    `SELECT 1 FROM tessera_canvases WHERE canvas_id = $1 FOR SHARE`, [id])).rowCount === 1
  if (!exists) {
    // Serialize only first-time world creation. Existing worlds never wait on this lock.
    await client.query(`SELECT pg_advisory_xact_lock(402, 402)`)
    exists = (await client.query(
      `SELECT 1 FROM tessera_canvases WHERE canvas_id = $1`, [id])).rowCount === 1
    if (!exists) {
      let worldCount = Number((await client.query(
        `SELECT count(*)::integer AS count FROM tessera_canvases`)).rows[0].count)
      if (worldCount >= tesseraWorldLimit() && await reclaimAbandonedCanvas(client)) {
        worldCount -= 1
      }
      if (worldCount >= tesseraWorldLimit()) {
        throw new PaymentError('WORLD_LIMIT_REACHED',
          'The public Tessera world limit has been reached; choose an existing world')
      }
      await client.query(
        `INSERT INTO tessera_canvases (canvas_id, name, width, height)
         VALUES ($1, $2, $3, $3)`,
        [id, canvasDisplayName(id), TESSERA_CANVAS_SIZE],
      )
    }
  }
  await client.query(
    `INSERT INTO tessera_slots (canvas_id, slot, status)
     SELECT $1, slot, 'available' FROM generate_series(0, $2) AS slot
     ON CONFLICT (canvas_id, slot) DO NOTHING`,
    [id, TESSERA_SLOT_COUNT - 1],
  )
}

export const tesseraCanvases = new Hono()

tesseraCanvases.get('/', async (c) => {
  try {
    const result = await database().query(
      `SELECT canvas.canvas_id, canvas.name, canvas.width, canvas.height,
              extract(epoch from canvas.created_at)::bigint AS created_at,
              count(DISTINCT pixel.x::text || ':' || pixel.y::text)::integer AS painted_pixels,
              count(DISTINCT slot.slot) FILTER (WHERE slot.status = 'allocated' AND
                lease.expires_at > clock_timestamp())::integer AS claimed_territories
       FROM tessera_canvases AS canvas
       LEFT JOIN tessera_pixels AS pixel ON pixel.canvas_id = canvas.canvas_id
       LEFT JOIN tessera_slots AS slot ON slot.canvas_id = canvas.canvas_id
       LEFT JOIN plot_jobs AS job ON job.quote_id = slot.quote_id AND job.status = 'complete'
       LEFT JOIN tool_leases AS lease ON lease.lease_id = job.lease_id
       GROUP BY canvas.canvas_id, canvas.name, canvas.width, canvas.height, canvas.created_at
       ORDER BY canvas.created_at, canvas.canvas_id LIMIT 100`,
    )
    c.header('Cache-Control', 'no-store')
    return c.json({ canvases: result.rows.map((row) => ({ canvas_id: String(row.canvas_id),
      name: String(row.name), width: Number(row.width), height: Number(row.height),
      created_at: Number(row.created_at), painted_pixels: Number(row.painted_pixels),
      claimed_territories: Number(row.claimed_territories) })) })
  } catch (error) {
    console.error(`Tessera canvas catalogue failed: ${error instanceof Error ? error.message : 'unknown error'}`)
    return c.json({ error: 'CANVASES_UNAVAILABLE', message: 'Canvas catalogue is temporarily unavailable' }, 503)
  }
})
