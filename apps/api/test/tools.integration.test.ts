import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { app } from '../src/app.js'
import { canonicalJson } from '../src/canonical.js'
import { closeDatabase, database, initializeDatabase } from '../src/db.js'
import { hashArgs, signInvocation, signLease, type Invocation, type LeaseClaims } from '../src/leases.js'

const service = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const subject = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const attacker = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const subjectPubkey = subject.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
const attackerPubkey = attacker.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
process.env.TOOL_LEASE_PRIVATE_KEY = service.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()

async function lease() {
  const exp = Math.floor(Date.now() / 1000) + 300
  const claims: LeaseClaims = {
    lease_id: randomUUID(), subject_pubkey: subjectPubkey,
    aud: new URL('/v1/tools', process.env.AUDITLAB_URL ?? 'http://127.0.0.1:3000').href,
    catalogue_hash: createHash('sha256').update(canonicalJson(['finding_details'])).digest('hex'),
    tool_ids: ['finding_details'], max_calls: 3, exp,
    offer_id: randomUUID(), hedera_tx_id: `0.0.1@${Date.now()}.${String(Math.random()).slice(2, 11)}`,
    scan_id: randomUUID(),
  }
  await database().query(
    `INSERT INTO tool_leases
       (lease_id, subject_pubkey, scan_id, hedera_tx_id, expires_at, max_calls, findings)
     VALUES ($1, $2, $3, $4, to_timestamp($5), $6, $7)`,
    [claims.lease_id, claims.subject_pubkey, claims.scan_id, claims.hedera_tx_id, claims.exp,
      claims.max_calls, JSON.stringify([{ id: 'missing-lockfile', severity: 'medium', message: 'Missing lockfile' }])],
  )
  return { claims, token: signLease(claims, service.privateKey) }
}

function request(token: string, claims: LeaseClaims, counter: number,
  key = subject.privateKey, pubkey = subjectPubkey, findingId = 'missing-lockfile') {
  const args = { finding_id: findingId }
  const invocation: Invocation = {
    lease_id: claims.lease_id, tool_id: 'finding_details', counter,
    args_hash: hashArgs(args), issued_at: Math.floor(Date.now() / 1000),
  }
  return app.request('/v1/tools/finding_details', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lease: token, args, counter,
      signature: signInvocation(invocation, pubkey, key) }),
  })
}

test('enforces ToolLease subject, counter, and server expiry', async (t) => {
  await initializeDatabase()
  t.after(async () => {
    await database().query(`DELETE FROM tool_leases WHERE subject_pubkey IN ($1, $2)`,
      [subjectPubkey, attackerPubkey])
    await closeDatabase()
  })

  await t.test('allows a signed finding_details invocation', async () => {
    const issued = await lease()
    const response = await request(issued.token, issued.claims, 1)
    assert.equal(response.status, 200)
    assert.equal((await response.json()).finding.id, 'missing-lockfile')
  })

  await t.test('denies a wrong subject key', async () => {
    const issued = await lease()
    const response = await request(issued.token, issued.claims, 1, attacker.privateKey, attackerPubkey)
    assert.equal(response.status, 403)
    assert.equal((await response.json()).error, 'SUBJECT_KEY_MISMATCH')
  })

  await t.test('denies the same signed invocation twice', async () => {
    const issued = await lease()
    const first = await request(issued.token, issued.claims, 1)
    const replay = await request(issued.token, issued.claims, 1)
    assert.equal(first.status, 200)
    assert.equal(replay.status, 403)
    assert.equal((await replay.json()).error, 'REPLAY_DETECTED')
  })

  await t.test('atomically allows only one concurrent use of a counter', async () => {
    const issued = await lease()
    const responses = await Promise.all([
      request(issued.token, issued.claims, 1),
      request(issued.token, issued.claims, 1),
    ])
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 403])
    const denied = responses.find((response) => response.status === 403)!
    assert.equal((await denied.json()).error, 'REPLAY_DETECTED')
    const state = await database().query(
      `SELECT used_calls, last_counter FROM tool_leases WHERE lease_id = $1`,
      [issued.claims.lease_id],
    )
    assert.deepEqual(state.rows[0], { used_calls: 1, last_counter: 1 })
  })

  await t.test('does not consume authority for an unknown finding', async () => {
    const issued = await lease()
    const response = await request(issued.token, issued.claims, 1,
      subject.privateKey, subjectPubkey, 'does-not-exist')
    assert.equal(response.status, 404)
    assert.equal((await response.json()).error, 'FINDING_NOT_FOUND')
    const state = await database().query(
      `SELECT used_calls, last_counter FROM tool_leases WHERE lease_id = $1`,
      [issued.claims.lease_id],
    )
    assert.deepEqual(state.rows[0], { used_calls: 0, last_counter: 0 })
  })

  await t.test('denies a lease expired on the server', async () => {
    const issued = await lease()
    await database().query(`UPDATE tool_leases SET expires_at = now() WHERE lease_id = $1`,
      [issued.claims.lease_id])
    const response = await request(issued.token, issued.claims, 1)
    assert.equal(response.status, 410)
    assert.equal((await response.json()).error, 'LEASE_EXPIRED')
  })
})
