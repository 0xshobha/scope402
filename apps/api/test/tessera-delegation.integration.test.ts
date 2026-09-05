import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { test } from 'node:test'
import type { PaymentRequirements } from '@x402/core/types'
import { app } from '../src/app.js'
import { closeDatabase, database, initializeDatabase } from '../src/db.js'
import type { TesseraLeaseClaims } from '../src/merchants/tessera/authorization.js'
import { fulfillPaidPlot } from '../src/merchants/tessera/jobs.js'
import { createPlotQuote, type PlotPricing } from '../src/merchants/tessera/quotes.js'
import { signDelegation, type DelegatedLeaseClaims,
  type DelegationTerms } from '../src/scope402/delegation.js'
import { hashArgs, signInvocation } from '../src/scope402/invocation.js'

const merchant = '0.0.2002'
const payer = '0.0.1001'
const endpoint = 'http://127.0.0.1:3000/v1/plots'
const audience = 'http://127.0.0.1:3000/v1/tools'
const requirements: PaymentRequirements = {
  scheme: 'exact', network: 'hedera:testnet', asset: '0.0.0', amount: '56000',
  payTo: merchant, maxTimeoutSeconds: 120, extra: { feePayer: '0.0.3003' },
}
const pricing: PlotPricing = {
  base_tinybars: '50000', per_call_tinybars: '500', calls: 12,
  total_tinybars: '56000',
}
const service = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const principal = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const worker = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const attacker = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const publicKey = (key: typeof principal) =>
  key.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
const principalPubkey = publicKey(principal)
const workerPubkey = publicKey(worker)
const attackerPubkey = publicKey(attacker)
let sequence = 1

type IssuedRoot = Awaited<ReturnType<typeof fulfillPaidPlot>> & {
  lease: TesseraLeaseClaims & { token: string }
}
type IssuedChild = DelegatedLeaseClaims & { token: string }

async function cleanTessera() {
  await database().query(`DELETE FROM tessera_pixels`)
  await database().query(
    `DELETE FROM plot_jobs
     WHERE quote_id IN (SELECT quote_id FROM payment_quotes WHERE merchant_id = 'tessera')`)
  await database().query(`DELETE FROM tool_leases WHERE merchant_id = 'tessera'`)
  await database().query(
    `DELETE FROM payment_redemptions WHERE quote_id IN
       (SELECT quote_id FROM payment_quotes WHERE merchant_id = 'tessera')`)
  await database().query(
    `UPDATE tessera_slots SET quote_id = NULL, status = 'available',
       reservation_expires_at = NULL, transaction_id = NULL`)
  await database().query(`DELETE FROM payment_quotes WHERE merchant_id = 'tessera'`)
}

async function issueRoot(): Promise<IssuedRoot> {
  const quote = await createPlotQuote(principalPubkey, endpoint, requirements, pricing, audience)
  const transactionId = `0.0.1001@1788618000.${String(sequence++).padStart(9, '0')}`
  const receipt = { success: true as const, network: 'hedera:testnet' as const,
    transaction: transactionId, payer }
  await database().query(
    `INSERT INTO payment_redemptions (transaction_id, quote_id, status, payer, receipt)
     VALUES ($1, $2, 'settled', $3, $4)`,
    [transactionId, quote.quoteId, payer, JSON.stringify(receipt)])
  return fulfillPaidPlot({ transactionId, quoteId: quote.quoteId, subjectPubkey: principalPubkey,
    requirements, receipt, policy: quote.extensions.scope402.info }) as Promise<IssuedRoot>
}

function childTerms(root: IssuedRoot, overrides: Partial<DelegationTerms> = {}): DelegationTerms {
  return {
    parent_lease_id: root.lease.lease_id, child_subject_pubkey: workerPubkey,
    resource: { ...root.region, width: 4, height: 4 }, tool_ids: ['place_pixel'],
    max_calls: 1, expires_at: root.lease.exp - 30, counter: 1,
    issued_at: Math.floor(Date.now() / 1000), ...overrides,
  }
}

function delegationBody(root: IssuedRoot, terms: DelegationTerms,
  key = principal.privateKey, pubkey = principalPubkey) {
  return JSON.stringify({ lease: root.lease.token,
    delegation: signDelegation(terms, pubkey, key) })
}

function delegate(root: IssuedRoot, terms: DelegationTerms,
  key = principal.privateKey, pubkey = principalPubkey) {
  return app.request(`/v1/leases/${root.lease.lease_id}/delegations`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: delegationBody(root, terms, key, pubkey) })
}

function pixelBody(lease: TesseraLeaseClaims & { token: string }, counter: number,
  key = worker.privateKey, pubkey = workerPubkey) {
  const args = { canvas_id: 'main', x: lease.resource.x, y: lease.resource.y, color: '#7C4DFF' }
  const invocation = { lease_id: lease.lease_id, tool_id: 'place_pixel', counter,
    args_hash: hashArgs(args), issued_at: Math.floor(Date.now() / 1000) }
  return JSON.stringify({ lease: lease.token, args, counter,
    signature: signInvocation(invocation, pubkey, key) })
}

function place(body: string) {
  return app.request('/v1/tools/place_pixel', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body })
}

async function parentState(leaseId: string) {
  const result = await database().query(
    `SELECT used_calls, reserved_calls, last_counter, last_delegation_counter
     FROM tool_leases WHERE lease_id = $1`, [leaseId])
  return result.rows[0] as { used_calls: number; reserved_calls: number
    last_counter: number; last_delegation_counter: number }
}

test('Tessera delegates attenuated capabilities with conserved authority', async (t) => {
  const oldKey = process.env.TOOL_LEASE_PRIVATE_KEY
  const oldPath = process.env.TOOL_LEASE_PRIVATE_KEY_PATH
  const oldOrigin = process.env.AUDITLAB_URL
  process.env.TOOL_LEASE_PRIVATE_KEY = service.privateKey
    .export({ format: 'pem', type: 'pkcs8' }).toString()
  delete process.env.TOOL_LEASE_PRIVATE_KEY_PATH
  process.env.AUDITLAB_URL = 'http://127.0.0.1:3000'
  await initializeDatabase()
  await cleanTessera()
  t.after(async () => {
    await cleanTessera()
    if (oldKey === undefined) delete process.env.TOOL_LEASE_PRIVATE_KEY
    else process.env.TOOL_LEASE_PRIVATE_KEY = oldKey
    if (oldPath === undefined) delete process.env.TOOL_LEASE_PRIVATE_KEY_PATH
    else process.env.TOOL_LEASE_PRIVATE_KEY_PATH = oldPath
    if (oldOrigin === undefined) delete process.env.AUDITLAB_URL
    else process.env.AUDITLAB_URL = oldOrigin
    await closeDatabase()
  })

  await t.test('a distinct worker paints once with a contained child capability', async () => {
    await cleanTessera()
    const root = await issueRoot()
    const response = await delegate(root, childTerms(root))
    assert.equal(response.status, 200)
    const delegated = await response.json() as { lease: IssuedChild; parent: {
      reserved_calls: number; remaining_calls: number } }
    assert.equal(delegated.lease.subject_pubkey, workerPubkey)
    assert.equal(delegated.lease.parent_lease_id, root.lease.lease_id)
    assert.equal(delegated.lease.root_lease_id, root.lease.lease_id)
    assert.equal(delegated.lease.offer_id, root.lease.offer_id)
    assert.equal(delegated.lease.hedera_tx_id, root.lease.hedera_tx_id)
    assert.equal(delegated.parent.reserved_calls, 1)
    assert.equal(delegated.parent.remaining_calls, 11)
    const parentUse = await place(pixelBody(root.lease, 1,
      principal.privateKey, principalPubkey))
    assert.equal(parentUse.status, 200)
    assert.equal((await parentUse.json()).remaining_calls, 10)
    const first = await place(pixelBody(delegated.lease as TesseraLeaseClaims & { token: string }, 1))
    assert.equal(first.status, 200)
    const exhausted = await place(pixelBody(
      delegated.lease as TesseraLeaseClaims & { token: string }, 2))
    assert.equal(exhausted.status, 403)
    assert.equal((await exhausted.json()).error, 'BUDGET_EXHAUSTED')
  })

  await t.test('wider, later, cross-canvas, and extra-tool children are denied without reservation', async () => {
    await cleanTessera()
    const root = await issueRoot()
    const invalid = [
      childTerms(root, { resource: root.region }),
      childTerms(root, { resource: { kind: 'canvas-region', canvasId: 'main',
        x: 0, y: 0, width: 32, height: 32 } }),
      childTerms(root, { expires_at: root.lease.exp + 1 }),
      childTerms(root, { resource: { ...root.region, canvasId: 'other', width: 4, height: 4 } }),
      childTerms(root, { tool_ids: ['place_pixel', 'finding_details'] }),
      childTerms(root, { tool_ids: ['place_pixel', 'place_pixel'] }),
    ]
    for (const terms of invalid) {
      const response = await delegate(root, terms)
      assert.equal(response.status, 403)
      assert.equal((await response.json()).error, 'CAPABILITY_ESCALATION_DENIED')
    }
    assert.deepEqual(await parentState(root.lease.lease_id), {
      used_calls: 0, reserved_calls: 0, last_counter: 0, last_delegation_counter: 0,
    })
  })

  await t.test('wrong key and replay cannot allocate worker authority twice', async () => {
    await cleanTessera()
    const root = await issueRoot()
    const terms = childTerms(root)
    const wrong = await delegate(root, terms, attacker.privateKey, attackerPubkey)
    assert.equal(wrong.status, 403)
    assert.equal((await wrong.json()).error, 'SUBJECT_KEY_MISMATCH')
    const body = delegationBody(root, terms)
    const responses = await Promise.all([0, 1].map(() =>
      app.request(`/v1/leases/${root.lease.lease_id}/delegations`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body })))
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 403])
    const denied = responses.find((response) => response.status === 403)!
    assert.equal((await denied.json()).error, 'REPLAY_DETECTED')
    assert.equal((await database().query(
      `SELECT count(*)::int AS count FROM tool_leases WHERE parent_lease_id = $1`,
      [root.lease.lease_id])).rows[0].count, 1)
  })

  await t.test('child-to-grandchild delegation is refused', async () => {
    await cleanTessera()
    const root = await issueRoot()
    const created = await delegate(root, childTerms(root))
    const child = (await created.json() as { lease: IssuedChild }).lease
    const terms = { ...childTerms(root), parent_lease_id: child.lease_id,
      child_subject_pubkey: attackerPubkey, expires_at: child.exp - 1 }
    const body = JSON.stringify({ lease: child.token,
      delegation: signDelegation(terms, workerPubkey, worker.privateKey) })
    const response = await app.request(`/v1/leases/${child.lease_id}/delegations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    assert.equal(response.status, 403)
    assert.equal((await response.json()).error, 'CAPABILITY_ESCALATION_DENIED')
  })

  await t.test('parent expiry invalidates its child', async () => {
    await cleanTessera()
    const root = await issueRoot()
    const child = (await (await delegate(root, childTerms(root))).json() as
      { lease: IssuedChild }).lease
    await database().query(`UPDATE tool_leases SET expires_at = now() WHERE lease_id = $1`,
      [root.lease.lease_id])
    const response = await place(pixelBody(child as TesseraLeaseClaims & { token: string }, 1))
    assert.equal(response.status, 410)
    assert.equal((await response.json()).error, 'LEASE_EXPIRED')
  })

  await t.test('concurrent children cannot oversubscribe remaining parent calls', async () => {
    await cleanTessera()
    const root = await issueRoot()
    const first = await delegate(root, childTerms(root, { max_calls: 9 }))
    assert.equal(first.status, 200)
    const requests = [
      delegate(root, childTerms(root, { max_calls: 2, counter: 2,
        child_subject_pubkey: publicKey(generateKeyPairSync('ec', { namedCurve: 'prime256v1' })) })),
      delegate(root, childTerms(root, { max_calls: 2, counter: 3,
        child_subject_pubkey: publicKey(generateKeyPairSync('ec', { namedCurve: 'prime256v1' })) })),
    ]
    const responses = await Promise.all(requests)
    assert.equal(responses.filter((response) => response.status === 200).length, 1)
    assert.equal(responses.filter((response) => response.status === 403).length, 1)
    const state = await parentState(root.lease.lease_id)
    assert.equal(state.reserved_calls, 11)
    assert.equal(state.used_calls + state.reserved_calls <= 12, true)
  })

  await t.test('parent use and child reservation cannot spend the same final call', async () => {
    await cleanTessera()
    const root = await issueRoot()
    assert.equal((await delegate(root, childTerms(root, { max_calls: 11 }))).status, 200)
    const args = { canvas_id: 'main', x: root.region.x, y: root.region.y, color: '#00D3F2' }
    const invocation = { lease_id: root.lease.lease_id, tool_id: 'place_pixel', counter: 1,
      args_hash: hashArgs(args), issued_at: Math.floor(Date.now() / 1000) }
    const rootPixel = place(JSON.stringify({ lease: root.lease.token, args, counter: 1,
      signature: signInvocation(invocation, principalPubkey, principal.privateKey) }))
    const reservation = delegate(root, childTerms(root, { counter: 2 }))
    const responses = await Promise.all([rootPixel, reservation])
    assert.equal(responses.filter((response) => response.status === 200).length, 1)
    const state = await parentState(root.lease.lease_id)
    assert.equal(state.used_calls + state.reserved_calls, 12)
  })
})
