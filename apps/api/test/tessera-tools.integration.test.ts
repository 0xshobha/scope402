import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { test } from 'node:test'
import type { PaymentRequirements } from '@x402/core/types'
import { app } from '../src/app.js'
import { closeDatabase, database, initializeDatabase } from '../src/db.js'
import { fulfillPaidPlot } from '../src/merchants/tessera/jobs.js'
import { createPlotQuote, type PlotPricing } from '../src/merchants/tessera/quotes.js'
import type { TesseraLeaseClaims } from '../src/merchants/tessera/authorization.js'
import { hashArgs, signInvocation } from '../src/scope402/invocation.js'

const merchant = '0.0.2002'
const payer = '0.0.1001'
const feePayer = '0.0.3003'
const endpoint = 'http://127.0.0.1:3000/v1/plots'
const audience = 'http://127.0.0.1:3000/v1/tools'
const requirements: PaymentRequirements = {
  scheme: 'exact', network: 'hedera:testnet', asset: '0.0.0', amount: '56000',
  payTo: merchant, maxTimeoutSeconds: 120, extra: { feePayer },
}
const pricing: PlotPricing = {
  base_tinybars: '50000', per_call_tinybars: '500', calls: 12,
  total_tinybars: '56000',
}
const service = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const subject = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const attacker = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const subjectPubkey = subject.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
const attackerPubkey = attacker.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
let transactionSequence = 1

type IssuedRoot = Awaited<ReturnType<typeof fulfillPaidPlot>> & {
  lease: TesseraLeaseClaims & { token: string }
}

async function cleanTessera() {
  await database().query(`DELETE FROM tessera_pixels`)
  await database().query(
    `DELETE FROM plot_jobs
     WHERE quote_id IN (SELECT quote_id FROM payment_quotes WHERE merchant_id = 'tessera')`,
  )
  await database().query(`DELETE FROM tool_leases WHERE merchant_id = 'tessera'`)
  await database().query(
    `DELETE FROM payment_redemptions WHERE quote_id IN
       (SELECT quote_id FROM payment_quotes WHERE merchant_id = 'tessera')`,
  )
  await database().query(
    `UPDATE tessera_slots SET quote_id = NULL, status = 'available',
       reservation_expires_at = NULL, transaction_id = NULL`,
  )
  await database().query(`DELETE FROM payment_quotes WHERE merchant_id = 'tessera'`)
}

async function issueRoot(): Promise<IssuedRoot> {
  const quote = await createPlotQuote(subjectPubkey, endpoint, requirements, pricing, audience)
  const transactionId = `0.0.1001@1788617000.${String(transactionSequence++).padStart(9, '0')}`
  const receipt = { success: true as const, network: 'hedera:testnet' as const,
    transaction: transactionId, payer }
  await database().query(
    `INSERT INTO payment_redemptions (transaction_id, quote_id, status, payer, receipt)
     VALUES ($1, $2, 'settled', $3, $4)`,
    [transactionId, quote.quoteId, payer, JSON.stringify(receipt)],
  )
  return fulfillPaidPlot({ transactionId, quoteId: quote.quoteId, subjectPubkey,
    requirements, receipt, policy: quote.extensions.scope402.info }) as Promise<IssuedRoot>
}

type PixelArgs = { canvas_id: string; x: number; y: number; color: string }

function signedPixelBody(issued: IssuedRoot, args: PixelArgs, counter: number,
  key = subject.privateKey, publicKey = subjectPubkey) {
  const invocation = { lease_id: issued.lease.lease_id, tool_id: 'place_pixel', counter,
    args_hash: hashArgs(args), issued_at: Math.floor(Date.now() / 1000) }
  return JSON.stringify({ lease: issued.lease.token, args, counter,
    signature: signInvocation(invocation, publicKey, key) })
}

function place(body: string) {
  return app.request('/v1/tools/place_pixel', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body })
}

async function capabilityState(leaseId: string) {
  const result = await database().query(
    `SELECT used_calls, last_counter FROM tool_leases WHERE lease_id = $1`, [leaseId])
  return result.rows[0] as { used_calls: number; last_counter: number }
}

test('Tessera enforces canvas authority and pixel mutation atomically', async (t) => {
  const previousKey = process.env.TOOL_LEASE_PRIVATE_KEY
  const previousKeyPath = process.env.TOOL_LEASE_PRIVATE_KEY_PATH
  const previousOrigin = process.env.AUDITLAB_URL
  process.env.TOOL_LEASE_PRIVATE_KEY = service.privateKey
    .export({ format: 'pem', type: 'pkcs8' }).toString()
  delete process.env.TOOL_LEASE_PRIVATE_KEY_PATH
  process.env.AUDITLAB_URL = 'http://127.0.0.1:3000'
  await initializeDatabase()
  await cleanTessera()
  t.after(async () => {
    await cleanTessera()
    if (previousKey === undefined) delete process.env.TOOL_LEASE_PRIVATE_KEY
    else process.env.TOOL_LEASE_PRIVATE_KEY = previousKey
    if (previousKeyPath === undefined) delete process.env.TOOL_LEASE_PRIVATE_KEY_PATH
    else process.env.TOOL_LEASE_PRIVATE_KEY_PATH = previousKeyPath
    if (previousOrigin === undefined) delete process.env.AUDITLAB_URL
    else process.env.AUDITLAB_URL = previousOrigin
    await closeDatabase()
  })

  await t.test('GET /v1/canvas returns empty server-authoritative state', async () => {
    const response = await app.request('/v1/canvas')
    assert.equal(response.status, 200)
    const canvas = await response.json()
    assert.equal(canvas.canvas_id, 'main')
    assert.equal(canvas.width, 32)
    assert.equal(canvas.height, 32)
    assert.equal(canvas.palette.length, 8)
    assert.deepEqual(canvas.pixels, [])
  })

  await t.test('an in-scope pixel commits and a fresh counter may repaint it', async () => {
    const issued = await issueRoot()
    const args = { canvas_id: 'main', x: issued.region.x, y: issued.region.y, color: '#7C4DFF' }
    const first = await place(signedPixelBody(issued, args, 1))
    assert.equal(first.status, 200)
    assert.equal((await first.json()).remaining_calls, 11)
    const repaint = { ...args, color: '#00D3F2' }
    const second = await place(signedPixelBody(issued, repaint, 2))
    assert.equal(second.status, 200)
    assert.equal((await second.json()).remaining_calls, 10)
    assert.deepEqual(await capabilityState(issued.lease.lease_id),
      { used_calls: 2, last_counter: 2 })
    const canvas = await (await app.request('/v1/canvas')).json()
    assert.equal(canvas.pixels.find((pixel: PixelArgs) =>
      pixel.x === args.x && pixel.y === args.y).color, '#00D3F2')
    assert.equal(canvas.regions.some((region: { lease_id: string }) =>
      region.lease_id === issued.lease.lease_id), true)
  })

  await t.test('an out-of-scope coordinate does not paint or consume', async () => {
    const issued = await issueRoot()
    const args = { canvas_id: 'main', x: issued.region.x + issued.region.width,
      y: issued.region.y, color: '#FF3B30' }
    const response = await place(signedPixelBody(issued, args, 1))
    assert.equal(response.status, 403)
    assert.equal((await response.json()).error, 'OUT_OF_SCOPE')
    assert.deepEqual(await capabilityState(issued.lease.lease_id),
      { used_calls: 0, last_counter: 0 })
    assert.equal((await database().query(
      `SELECT count(*)::int AS count FROM tessera_pixels WHERE lease_id = $1`,
      [issued.lease.lease_id])).rows[0].count, 0)
  })

  await t.test('wrong canvas and invalid color do not paint or consume', async () => {
    for (const mutate of [
      (args: PixelArgs) => ({ ...args, canvas_id: 'other' }),
      (args: PixelArgs) => ({ ...args, color: '#123456' }),
    ]) {
      const issued = await issueRoot()
      const args = mutate({ canvas_id: 'main', x: issued.region.x,
        y: issued.region.y, color: '#C6F432' })
      const response = await place(signedPixelBody(issued, args, 1))
      assert.equal(response.status, 403)
      assert.equal((await response.json()).error,
        args.canvas_id === 'main' ? 'INVALID_COLOR' : 'OUT_OF_SCOPE')
      assert.deepEqual(await capabilityState(issued.lease.lease_id),
        { used_calls: 0, last_counter: 0 })
    }
  })

  await t.test('a wrong subject key cannot use the root capability', async () => {
    const issued = await issueRoot()
    const args = { canvas_id: 'main', x: issued.region.x, y: issued.region.y, color: '#FFB020' }
    const response = await place(signedPixelBody(
      issued, args, 1, attacker.privateKey, attackerPubkey))
    assert.equal(response.status, 403)
    assert.equal((await response.json()).error, 'SUBJECT_KEY_MISMATCH')
    assert.deepEqual(await capabilityState(issued.lease.lease_id),
      { used_calls: 0, last_counter: 0 })
  })

  await t.test('the byte-identical signed invocation paints and consumes once', async () => {
    const issued = await issueRoot()
    const args = { canvas_id: 'main', x: issued.region.x, y: issued.region.y, color: '#FFFFFF' }
    const body = signedPixelBody(issued, args, 1)
    const [first, replay] = await Promise.all([place(body), place(body)])
    assert.deepEqual([first.status, replay.status].sort(), [200, 403])
    const denied = first.status === 403 ? first : replay
    assert.equal((await denied.json()).error, 'REPLAY_DETECTED')
    assert.deepEqual(await capabilityState(issued.lease.lease_id),
      { used_calls: 1, last_counter: 1 })
    assert.equal((await database().query(
      `SELECT count(*)::int AS count FROM tessera_pixels WHERE lease_id = $1`,
      [issued.lease.lease_id])).rows[0].count, 1)
  })

  await t.test('server-side expiry prevents pixel mutation', async () => {
    const issued = await issueRoot()
    await database().query(
      `UPDATE tool_leases SET expires_at = clock_timestamp() WHERE lease_id = $1`,
      [issued.lease.lease_id])
    const args = { canvas_id: 'main', x: issued.region.x, y: issued.region.y, color: '#F5F2EA' }
    const response = await place(signedPixelBody(issued, args, 1))
    assert.equal(response.status, 410)
    assert.equal((await response.json()).error, 'LEASE_EXPIRED')
    assert.deepEqual(await capabilityState(issued.lease.lease_id),
      { used_calls: 0, last_counter: 0 })
  })

  await t.test('exactly twelve calls succeed and call thirteen is denied', async () => {
    const issued = await issueRoot()
    const args = { canvas_id: 'main', x: issued.region.x, y: issued.region.y, color: '#0B0B0C' }
    for (let counter = 1; counter <= 12; counter += 1) {
      const response = await place(signedPixelBody(issued, args, counter))
      assert.equal(response.status, 200)
      assert.equal((await response.json()).remaining_calls, 12 - counter)
    }
    const denied = await place(signedPixelBody(issued, args, 13))
    assert.equal(denied.status, 403)
    assert.equal((await denied.json()).error, 'BUDGET_EXHAUSTED')
    assert.deepEqual(await capabilityState(issued.lease.lease_id),
      { used_calls: 12, last_counter: 12 })
  })

  await t.test('concurrent different pixels with the same counter commit exactly one', async () => {
    const issued = await issueRoot()
    const firstArgs = { canvas_id: 'main', x: issued.region.x,
      y: issued.region.y, color: '#FFB020' }
    const secondArgs = { ...firstArgs, x: issued.region.x + 1, color: '#C6F432' }
    const responses = await Promise.all([
      place(signedPixelBody(issued, firstArgs, 1)),
      place(signedPixelBody(issued, secondArgs, 1)),
    ])
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 403])
    const denied = responses.find((response) => response.status === 403)!
    assert.equal((await denied.json()).error, 'REPLAY_DETECTED')
    assert.deepEqual(await capabilityState(issued.lease.lease_id),
      { used_calls: 1, last_counter: 1 })
    assert.equal((await database().query(
      `SELECT count(*)::int AS count FROM tessera_pixels WHERE lease_id = $1`,
      [issued.lease.lease_id])).rows[0].count, 1)
  })
})
