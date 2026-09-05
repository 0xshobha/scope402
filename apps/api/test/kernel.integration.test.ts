import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { closeDatabase, database, initializeDatabase, transaction,
  type TransactionClient } from '../src/db.js'
import { LeaseError } from '../src/lease-error.js'
import { authorizeCanvasPoint, rootCanvasRegion } from '../src/merchants/tessera/resource.js'
import { authorizeAndCommitInTransaction } from '../src/scope402/authorize.js'
import { hashArgs, type Scope402Invocation } from '../src/scope402/invocation.js'
import type { BaseLeaseClaims } from '../src/scope402/lease.js'
import type { CanvasRegionResource } from '../src/scope402/policy.js'

const inside = { canvasId: 'main', x: 8, y: 8 }

function invocation(claims: BaseLeaseClaims, counter = 1,
  args: unknown = inside): Scope402Invocation {
  return { lease_id: claims.lease_id, tool_id: 'test_action', counter,
    args_hash: hashArgs(args), issued_at: Math.floor(Date.now() / 1000) }
}

async function createCapability(maxCalls = 1) {
  const resource = rootCanvasRegion(5)
  const claims: BaseLeaseClaims = {
    lease_id: randomUUID(), subject_pubkey: `subject-${randomUUID()}`,
    aud: 'https://scope402.example/v1/tools', catalogue_hash: 'catalogue',
    tool_ids: ['test_action'], max_calls: maxCalls, exp: Math.floor(Date.now() / 1000) + 300,
    offer_id: randomUUID(), hedera_tx_id: `0.0.1@${Date.now()}.${String(Math.random()).slice(2, 11)}`,
    policy_hash: `sha256:${'a'.repeat(64)}`, resource,
  }
  await database().query(
    `INSERT INTO tool_leases
       (lease_id, subject_pubkey, scan_id, hedera_tx_id, expires_at, max_calls, policy_hash,
        resource, audience, catalogue_hash, tool_ids, format_version, findings)
     VALUES ($1, $2, $3, $4, to_timestamp($5), $6, $7, $8, $9, $10, $11, 1, '[]'::jsonb)`,
    [claims.lease_id, claims.subject_pubkey, randomUUID(), claims.hedera_tx_id,
      claims.exp, claims.max_calls, claims.policy_hash, JSON.stringify(resource), claims.aud,
      claims.catalogue_hash, JSON.stringify(claims.tool_ids)],
  )
  await database().query(
    `INSERT INTO scope402_kernel_test_effects (lease_id, writes) VALUES ($1, 0)`,
    [claims.lease_id],
  )
  return claims
}

function adapter(options: { point?: unknown; failAfterWrite?: boolean; callbacks?: () => void } = {}) {
  return {
    authorizeResourceAction: async (_client: TransactionClient,
      context: { state: { resource?: unknown } }) => {
      options.callbacks?.()
      return authorizeCanvasPoint(context.state.resource as CanvasRegionResource,
        options.point ?? inside)
    },
    commitBusinessMutation: async (client: TransactionClient,
      context: { state: { leaseId: string } }) => {
      options.callbacks?.()
      await client.query(
        `UPDATE scope402_kernel_test_effects SET writes = writes + 1 WHERE lease_id = $1`,
        [context.state.leaseId],
      )
      if (options.failAfterWrite) throw new Error('business mutation failed')
      return 'committed'
    },
  }
}

async function state(leaseId: string) {
  const lease = await database().query(
    `SELECT used_calls, last_counter FROM tool_leases WHERE lease_id = $1`, [leaseId])
  const effect = await database().query(
    `SELECT writes FROM scope402_kernel_test_effects WHERE lease_id = $1`, [leaseId])
  return { lease: lease.rows[0], writes: effect.rows[0].writes as number }
}

test('shared authorization kernel keeps capability and merchant state atomic', async (t) => {
  await initializeDatabase()
  await database().query(
    `CREATE TABLE IF NOT EXISTS scope402_kernel_test_effects (
       lease_id uuid PRIMARY KEY,
       writes integer NOT NULL DEFAULT 0
     )`,
  )
  t.after(async () => {
    await database().query(
      `DELETE FROM scope402_kernel_test_effects WHERE lease_id IN
         (SELECT lease_id FROM tool_leases WHERE subject_pubkey LIKE 'subject-%')`,
    )
    await database().query(`DELETE FROM tool_leases WHERE subject_pubkey LIKE 'subject-%'`)
    await database().query(`DROP TABLE IF EXISTS scope402_kernel_test_effects`)
    await closeDatabase()
  })

  await t.test('out-of-scope canvas denial changes neither budget nor merchant state', async () => {
    const claims = await createCapability()
    const region = claims.resource as CanvasRegionResource
    for (const outside of [
      { canvasId: region.canvasId, x: region.x - 1, y: region.y },
      { canvasId: region.canvasId, x: region.x, y: region.y - 1 },
      { canvasId: region.canvasId, x: region.x + region.width, y: region.y },
      { canvasId: region.canvasId, x: region.x, y: region.y + region.height },
    ]) {
      await assert.rejects(
        transaction((client) => authorizeAndCommitInTransaction(
          client, claims, invocation(claims, 1, outside), outside, adapter({ point: outside }))),
        (error) => error instanceof LeaseError && error.code === 'OUT_OF_SCOPE',
      )
    }
    assert.deepEqual(await state(claims.lease_id), {
      lease: { used_calls: 0, last_counter: 0 }, writes: 0,
    })
  })

  await t.test('merchant failure rolls back its write and capability consumption', async () => {
    const claims = await createCapability()
    await assert.rejects(
      transaction((client) => authorizeAndCommitInTransaction(
        client, claims, invocation(claims), inside, adapter({ failAfterWrite: true }))),
      /business mutation failed/)
    assert.deepEqual(await state(claims.lease_id), {
      lease: { used_calls: 0, last_counter: 0 }, writes: 0,
    })
  })

  await t.test('same-counter race commits exactly one merchant mutation', async () => {
    const claims = await createCapability()
    const attempt = () => transaction((client) => authorizeAndCommitInTransaction(
      client, claims, invocation(claims), inside, adapter()))
    const outcomes = await Promise.allSettled([attempt(), attempt()])
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1)
    const denied = outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult
    assert.equal(denied.reason instanceof LeaseError && denied.reason.code, 'REPLAY_DETECTED')
    assert.deepEqual(await state(claims.lease_id), {
      lease: { used_calls: 1, last_counter: 1 }, writes: 1,
    })
  })

  await t.test('budget exhaustion invokes no additional merchant callback', async () => {
    const claims = await createCapability()
    await transaction((client) => authorizeAndCommitInTransaction(
      client, claims, invocation(claims), inside, adapter()))
    let callbacks = 0
    const outside = { canvasId: 'main', x: 0, y: 0 }
    await assert.rejects(
      transaction((client) => authorizeAndCommitInTransaction(
        client, claims, invocation(claims, 2, outside), outside,
        adapter({ point: outside, callbacks: () => { callbacks += 1 } }))),
      (error) => error instanceof LeaseError && error.code === 'BUDGET_EXHAUSTED',
    )
    assert.equal(callbacks, 0)
    assert.deepEqual(await state(claims.lease_id), {
      lease: { used_calls: 1, last_counter: 1 }, writes: 1,
    })
  })

  await t.test('policy, subject, and argument mismatches invoke no merchant callback', async () => {
    for (const [mutate, code] of [
      [(claims: BaseLeaseClaims) => ({ ...claims, policy_hash: `sha256:${'b'.repeat(64)}` }),
        'LEASE_REQUIRED'],
      [(claims: BaseLeaseClaims) => ({ ...claims, subject_pubkey: 'another-subject' }),
        'SUBJECT_KEY_MISMATCH'],
    ] as const) {
      const claims = await createCapability()
      const changed = mutate(claims)
      let callbacks = 0
      const outside = { canvasId: 'main', x: 0, y: 0 }
      await assert.rejects(
        transaction((client) => authorizeAndCommitInTransaction(
          client, changed, invocation(changed, 1, outside), outside,
          adapter({ point: outside, callbacks: () => { callbacks += 1 } }))),
        (error) => error instanceof LeaseError && error.code === code,
      )
      assert.equal(callbacks, 0)
    }

    const claims = await createCapability()
    let callbacks = 0
    await assert.rejects(
      transaction((client) => authorizeAndCommitInTransaction(
        client, claims, invocation(claims), { ...inside, x: 9 },
        adapter({ callbacks: () => { callbacks += 1 } }))),
      (error) => error instanceof LeaseError && error.code === 'ARGUMENT_HASH_MISMATCH',
    )
    assert.equal(callbacks, 0)
  })

  await t.test('expiry takes precedence over an out-of-scope resource', async () => {
    const claims = await createCapability()
    await database().query(`UPDATE tool_leases SET expires_at = now() WHERE lease_id = $1`,
      [claims.lease_id])
    let callbacks = 0
    const outside = { canvasId: 'main', x: 0, y: 0 }
    await assert.rejects(
      transaction((client) => authorizeAndCommitInTransaction(
        client, claims, invocation(claims, 1, outside), outside,
        adapter({ point: outside, callbacks: () => { callbacks += 1 } }))),
      (error) => error instanceof LeaseError && error.code === 'LEASE_EXPIRED',
    )
    assert.equal(callbacks, 0)
    assert.deepEqual(await state(claims.lease_id), {
      lease: { used_calls: 0, last_counter: 0 }, writes: 0,
    })
  })

  await t.test('tampered signed resource differs from persisted resource and invokes no callback', async () => {
    const claims = await createCapability()
    const changed = { ...claims, resource: rootCanvasRegion(6) }
    let callbacks = 0
    await assert.rejects(
      transaction((client) => authorizeAndCommitInTransaction(
        client, changed, invocation(changed), inside,
        adapter({ callbacks: () => { callbacks += 1 } }))),
      (error) => error instanceof LeaseError && error.code === 'LEASE_REQUIRED',
    )
    assert.equal(callbacks, 0)
    assert.deepEqual(await state(claims.lease_id), {
      lease: { used_calls: 0, last_counter: 0 }, writes: 0,
    })
  })

  await t.test('resource-bearing claims cannot use legacy or malformed persisted state', async () => {
    for (const persisted of [null, {
      kind: 'canvas-region', canvasId: 'main', x: 0, y: 0, width: 0, height: 8,
    }]) {
      const claims = await createCapability()
      await database().query(
        `UPDATE tool_leases SET resource = $2, audience = NULL, catalogue_hash = NULL,
           tool_ids = NULL WHERE lease_id = $1`,
        [claims.lease_id, persisted === null ? null : JSON.stringify(persisted)],
      )
      let callbacks = 0
      await assert.rejects(
        transaction((client) => authorizeAndCommitInTransaction(
          client, claims, invocation(claims), inside,
          adapter({ callbacks: () => { callbacks += 1 } }))),
        (error) => error instanceof LeaseError && error.code === 'LEASE_REQUIRED',
      )
      assert.equal(callbacks, 0)
      assert.deepEqual(await state(claims.lease_id), {
        lease: { used_calls: 0, last_counter: 0 }, writes: 0,
      })
    }
  })
})
