import { createHash } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { database } from '../../db.js'
import { TESSERA_PALETTE } from './palette.js'
import { rootCanvasRegion, parseCanvasId, TESSERA_CANVAS_ID } from './resource.js'

export const tesseraCanvas = new Hono()

function agentFingerprint(subjectPubkey: unknown) {
  return `agent:${createHash('sha256').update(String(subjectPubkey)).digest('hex').slice(0, 12)}`
}

async function readCanvas(rawCanvasId: unknown) {
    const canvasId = parseCanvasId(rawCanvasId)
    const [canvas, pixels, contributionRows, events, reservations, regions] = await Promise.all([
      database().query(
        `SELECT name, width, height, latitude, longitude FROM tessera_canvases WHERE canvas_id = $1`, [canvasId]),
      database().query(
        `SELECT pixel.x, pixel.y, pixel.color, pixel.lease_id, lease.subject_pubkey,
                extract(epoch from pixel.updated_at)::bigint AS updated_at
         FROM tessera_pixels AS pixel
         JOIN tool_leases AS lease ON lease.lease_id = pixel.lease_id
         WHERE pixel.canvas_id = $1 ORDER BY pixel.y, pixel.x`,
        [canvasId],
      ),
      database().query(
        `SELECT lease.subject_pubkey, count(*)::integer AS placements,
                extract(epoch from max(event.painted_at))::bigint AS last_active
         FROM tessera_pixel_events AS event
         JOIN tool_leases AS lease ON lease.lease_id = event.lease_id
         WHERE event.canvas_id = $1
         GROUP BY lease.subject_pubkey`,
        [canvasId],
      ),
      database().query(
        `SELECT event.x, event.y, event.color, event.counter, lease.subject_pubkey,
                extract(epoch from event.painted_at)::bigint AS painted_at
         FROM tessera_pixel_events AS event
         JOIN tool_leases AS lease ON lease.lease_id = event.lease_id
         WHERE event.canvas_id = $1
         ORDER BY event.painted_at DESC, event.event_id DESC LIMIT 12`,
        [canvasId],
      ),
      database().query(
        `SELECT slot.slot, quote.subject_pubkey,
                extract(epoch from slot.reservation_expires_at)::bigint AS expires_at
         FROM tessera_slots AS slot
         JOIN payment_quotes AS quote ON quote.quote_id = slot.quote_id
         WHERE slot.canvas_id = $1 AND slot.status = 'pending'
           AND slot.reservation_expires_at > clock_timestamp()
         ORDER BY slot.slot`,
        [canvasId],
      ),
      database().query(
        `SELECT slot.slot, job.lease_id, lease.subject_pubkey,
                extract(epoch from lease.expires_at)::bigint AS expires_at,
                lease.max_calls - lease.used_calls - lease.reserved_calls AS remaining_calls,
                lease.expires_at > now() AS active
         FROM tessera_slots AS slot
         JOIN plot_jobs AS job ON job.quote_id = slot.quote_id AND job.status = 'complete'
         JOIN tool_leases AS lease ON lease.lease_id = job.lease_id
         WHERE slot.canvas_id = $1 AND slot.status = 'allocated'
         ORDER BY slot.slot`,
        [canvasId],
      ),
    ])
    if (canvas.rowCount !== 1) return undefined
    const metadata = canvas.rows[0]
    const width = Number(metadata.width)
    const height = Number(metadata.height)
    const publicPixels = pixels.rows.map((row) => ({ x: Number(row.x), y: Number(row.y),
      color: String(row.color), updated_at: Number(row.updated_at),
      agent: agentFingerprint(row.subject_pubkey) }))
    const ownership = new Map<string, { agent: string; current_pixels: number; last_active: number }>()
    for (const pixel of publicPixels) {
      const current = ownership.get(pixel.agent)
      ownership.set(pixel.agent, { agent: pixel.agent,
        current_pixels: (current?.current_pixels ?? 0) + 1,
        last_active: Math.max(current?.last_active ?? 0, pixel.updated_at) })
    }
    const recentActivity = events.rows.map((row) => ({ x: Number(row.x), y: Number(row.y),
      color: String(row.color), counter: Number(row.counter),
      agent: agentFingerprint(row.subject_pubkey), painted_at: Number(row.painted_at) }))
    const contributions = new Map(contributionRows.rows.map((row) => {
      const agent = agentFingerprint(row.subject_pubkey)
      return [agent, { agent, placements: Number(row.placements), last_active: Number(row.last_active) }]
    }))
    for (const current of ownership.values()) {
      const recorded = contributions.get(current.agent)
      contributions.set(current.agent, { agent: current.agent,
        placements: Math.max(recorded?.placements ?? 0, current.current_pixels),
        last_active: Math.max(recorded?.last_active ?? 0, current.last_active) })
    }
    const contributionList = [...contributions.values()]
    const leaderboard = contributionList.sort((left, right) =>
      right.placements - left.placements || right.last_active - left.last_active ||
      left.agent.localeCompare(right.agent)).slice(0, 10).map((entry) => ({ ...entry,
        current_pixels: ownership.get(entry.agent)?.current_pixels ?? 0 }))
    const totalPlacements = contributionList.reduce((total, entry) => total + entry.placements, 0)
    return { canvas_id: canvasId, width, height, palette: TESSERA_PALETTE,
      location: { latitude: Number(metadata.latitude), longitude: Number(metadata.longitude) },
      world: { name: String(metadata.name), painted_pixels: publicPixels.length,
        total_placements: totalPlacements,
        total_pixels: width * height,
        completion_percent: Number(((publicPixels.length / (width * height)) * 100).toFixed(2)),
        current_painters: ownership.size,
        active_territories: regions.rows.filter((row) => Boolean(row.active)).length,
        reserved_territories: reservations.rows.length },
      pixels: publicPixels,
      leaderboard,
      recent_activity: recentActivity,
      reservations: reservations.rows.map((row) => ({ slot: Number(row.slot),
        ...rootCanvasRegion(Number(row.slot), canvasId), agent: agentFingerprint(row.subject_pubkey),
        expires_at: Number(row.expires_at), status: 'reserved' as const })),
      regions: regions.rows.map((row) => ({ slot: Number(row.slot),
        ...rootCanvasRegion(Number(row.slot), canvasId), lease_id: String(row.lease_id),
        agent: agentFingerprint(row.subject_pubkey),
        expires_at: Number(row.expires_at), remaining_calls: Number(row.remaining_calls),
        active: Boolean(row.active), status: row.active ? 'active' : 'expired' })) }
}

async function canvasResponse(c: Context, rawCanvasId: unknown) {
  try {
    const canvas = await readCanvas(rawCanvasId)
    if (!canvas) return c.json({ error: 'CANVAS_NOT_FOUND',
      message: 'This Tessera canvas does not exist' }, 404)
    c.header('Cache-Control', 'no-store')
    return c.json(canvas)
  } catch (error) {
    console.error(`Tessera canvas read failed: ${error instanceof Error ? error.message : 'unknown error'}`)
    return c.json({ error: 'CANVAS_UNAVAILABLE', message: 'Canvas state is temporarily unavailable' }, 503)
  }
}

async function canvasEventsResponse(c: Context, rawCanvasId: unknown) {
  try {
    const canvasId = parseCanvasId(rawCanvasId)
    const initial = await readCanvas(canvasId)
    if (!initial) return c.json({ error: 'CANVAS_NOT_FOUND',
      message: 'This Tessera canvas does not exist' }, 404)
    c.header('X-Accel-Buffering', 'no')
    return streamSSE(c, async (stream) => {
      let canvas = initial
      let lastDigest = ''
      let heartbeat = 0
      while (!stream.aborted && !stream.closed) {
        const data = JSON.stringify(canvas)
        const digest = createHash('sha256').update(data).digest('hex')
        if (digest !== lastDigest) {
          await stream.writeSSE({ event: 'world', id: digest.slice(0, 16), data, retry: 5_000 })
          lastDigest = digest
          heartbeat = 0
        } else if (++heartbeat >= 8) {
          await stream.writeSSE({ event: 'heartbeat', data: JSON.stringify({ canvas_id: canvasId }) })
          heartbeat = 0
        }
        await stream.sleep(2_000)
        if (stream.aborted || stream.closed) break
        const next = await readCanvas(canvasId)
        if (!next) {
          await stream.writeSSE({ event: 'error', data: JSON.stringify({ code: 'CANVAS_NOT_FOUND' }) })
          break
        }
        canvas = next
      }
    }, async (error) => {
      console.error(`Tessera canvas stream failed: ${error.message}`)
    })
  } catch (error) {
    console.error(`Tessera canvas stream failed: ${error instanceof Error ? error.message : 'unknown error'}`)
    return c.json({ error: 'CANVAS_UNAVAILABLE', message: 'Canvas stream is temporarily unavailable' }, 503)
  }
}

tesseraCanvas.get('/', (c) => canvasResponse(c, TESSERA_CANVAS_ID))
tesseraCanvas.get('/events', (c) => canvasEventsResponse(c, TESSERA_CANVAS_ID))
tesseraCanvas.get('/:canvasId/events', (c) => canvasEventsResponse(c, c.req.param('canvasId')))
tesseraCanvas.get('/:canvasId', (c) => canvasResponse(c, c.req.param('canvasId')))
