import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runCli } from '../src/cli.js'

const world = {
  canvas_id: 'main', location: { latitude: 19.076, longitude: 72.8777 },
  width: 32, height: 32, palette: ['#FFFFFF'],
  world: { name: 'Opal World', painted_pixels: 0, total_placements: 0,
    total_pixels: 1024, completion_percent: 0, current_painters: 0,
    active_territories: 0, reserved_territories: 0 },
  pixels: [], regions: [], reservations: [], leaderboard: [], recent_activity: [],
}

test('CLI lists worlds without payment configuration', async () => {
  const output: string[] = []
  const paths: string[] = []
  const request = (async (input: string | URL | Request) => {
    paths.push(new URL(String(input)).pathname)
    return Response.json({ canvases: [{ canvas_id: 'main', name: 'Opal World', width: 32,
      height: 32, location: world.location, created_at: 1, painted_pixels: 0, claimed_territories: 0 }] })
  }) as typeof fetch
  assert.equal(await runCli(['worlds'], output.push.bind(output), output.push.bind(output), request), 0)
  assert.deepEqual(paths, ['/v1/canvases'])
  assert.equal(JSON.parse(output[0]!).canvases[0].canvas_id, 'main')
})

test('CLI reads and validates one named world', async () => {
  const output: string[] = []
  const request = (async () => Response.json({ ...world, canvas_id: 'agent-garden',
    world: { ...world.world, name: 'Agent Garden' } })) as typeof fetch
  assert.equal(await runCli(['world', 'agent-garden', '--api', 'https://merchant.example'],
    output.push.bind(output), output.push.bind(output), request), 0)
  assert.equal(JSON.parse(output[0]!).canvas_id, 'agent-garden')
})

test('CLI watches validated world snapshots as newline-delimited JSON', async () => {
  const output: string[] = []
  const encoder = new TextEncoder()
  const snapshot = { ...world, palette: ['#7C4DFF'],
    world: { name: 'Opal World', painted_pixels: 0, total_placements: 0,
      total_pixels: 1024, completion_percent: 0, current_painters: 0,
      active_territories: 0, reserved_territories: 0 }, pixels: [], regions: [],
    reservations: [], leaderboard: [], recent_activity: [] }
  const request = async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode(`event: world\ndata: ${JSON.stringify(snapshot)}\n\n`))
    controller.close()
  } }), { headers: { 'Content-Type': 'text/event-stream' } })
  const result = await runCli(['watch', 'main'], (value) => output.push(value),
    () => undefined, request as typeof fetch)
  assert.equal(result, 0)
  assert.equal(output.length, 1)
  assert.equal(JSON.parse(output[0]!).canvas_id, 'main')
})

test('CLI rejects unsafe remote HTTP and invalid commands before network access', async () => {
  let calls = 0
  const output: string[] = []
  const request = (async () => { calls += 1; return Response.json({}) }) as typeof fetch
  assert.equal(await runCli(['worlds', '--api', 'http://merchant.example'],
    output.push.bind(output), output.push.bind(output), request), 1)
  assert.equal(await runCli(['paint'], output.push.bind(output), output.push.bind(output), request), 1)
  assert.equal(calls, 0)
})
