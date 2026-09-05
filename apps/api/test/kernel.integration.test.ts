import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { closeDatabase, database, initializeDatabase, transaction,
  type TransactionClient } from '../src/db.js'
import { LeaseError } from '../src/lease-error.js'
import { authorizeAndCommitInTransaction, type CapabilityStore,
  type LockedCapabilityState } from '../src/scope402/authorize.js'
import type { Scope402Invocation } from '../src/scope402/invocation.js'
import type { BaseLeaseClaims } from '../src/scope402/lease.js'

type TestState = LockedCapabilityState & { leaseId: string }

const store: CapabilityStore<TestState> = {
  async lock(client, leaseId) {
    const result = await client.query(
      `SELECT lease_id, subject_pubkey, policy_hash,
              extract(epoch from expires_at)::bigint AS expires_at,
              expires_at <= clock_timestamp() AS expired,
              used_calls, max_calls, last_counter
       FROM tool_leases WHERE lease_id = $1 FOR UPDATE`, [leaseId])
    if (result.rowCount !== 1) return undefined
    const row = result.rows[0]
    return {
      leaseId: String(row.lease_id), subjectPubkey: String(row.subject_pubkey),
      policyHash: row.policy_hash ?? undefined, expiresAt: Number(row.expires_at),
      expired: Boolean(row.expired),
      usedCalls: Number(row.used_calls), maxCalls: Number(row.max_calls),
      lastCounter: Number(row.last_counter),
    }
  },
  async consume(client, state, counter) {
    const result = await client.query(
      `UPDATE tool_leases SET used_calls = used_calls + 1, last_counter = $2
       WHERE lease_id = $1 AND last_counter + 1 = $2 AND used_calls < max_calls
         AND revoked_at IS NULL AND expires_at > clock_timestamp()
       RETURNING lease_id`, [state.leaseId, counter])
    return result.rowCount === 1
  },
}

function invocation(claims: BaseLeaseClaims, counter = 1): Scope402Invocation {
  return { lease_id: claims.lease_id, tool_id: 'test_action', counter,
    args_hash: 'test-hash', issued_at: Math.floor(Date.now() / 1000) }
}

async function createCapability() {
  const claims: BaseLeaseClaims = {
    lease_id: randomUUID(), subject_pubkey: `subject-${randomUUID()}`,
    aud: 'https://scope402.example/v1/tools', catalogue_hash: 'catalogue',
    tool_ids: ['test_action'], max_calls: 1, exp: Math.floor(Date.now() / 1000) + 300,
    offer_id: randomUUID(), hedera_tx_id: `0.0.1@${Date.now()}.${String(Math.random()).slice(2, 11)}`,
    policy_hash: `sha256:${'a'.repeat(64)}`,
  }
  await database().query(
    `INSERT INTO tool_leases
       (lease_id, subject_pubkey, scan_id, hedera_tx_id, expires_at, max_calls, policy_hash, findings)
     VALUES ($1, $2, $3, $4, to_timestamp($5), $6, $7, '[]'::jsonb)`,
    [claims.lease_id, claims.subject_pubkey, randomUUID(), claims.hedera_tx_id,
      claims.exp, claims.max_calls, claims.policy_hash],
  )
  await database().query(
    `INSERT INTO scope402_kernel_test_effects (lease_id, writes) VALUES ($1, 0)`,
    [claims.lease_id],
  )
  return claims
}

function adapter(options: { deny?: boolean; failAfterWrite?: boolean } = {}) {
  return {
    authorizeResourceAction: async () => {
      if (options.deny) throw new LeaseError('OUT_OF_SCOPE', 'Resource is outside this capability')
      return true
    },
    commitBusinessMutation: async (client: TransactionClient, state: TestState) => {
      await client.query(
        `UPDATE scope402_kernel_test_effects SET writes = writes + 1 WHERE lease_id = $1`,
        [state.leaseId],
      )
      if (options.failAfterWrite) throw new Error('business mutation failed')
      return 'committed'
    },
  }
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

  await t.test('resource denial changes neither budget nor merchant state', async () => {
    const claims = await createCapability()
    await assert.rejects(
      transaction((client) => authorizeAndCommitInTransaction(client, claims, invocation(claims), store,
        adapter({ deny: true }))),
      (error) => error instanceof LeaseError && error.code === 'OUT_OF_SCOPE',
    )
    const lease = await database().query(
      `SELECT used_calls, last_counter FROM tool_leases WHERE lease_id = $1`, [claims.lease_id])
    const effect = await database().query(
      `SELECT writes FROM scope402_kernel_test_effects WHERE lease_id = $1`, [claims.lease_id])
    assert.deepEqual(lease.rows[0], { used_calls: 0, last_counter: 0 })
    assert.equal(effect.rows[0].writes, 0)
  })

  await t.test('merchant failure rolls back its write and capability consumption', async () => {
    const claims = await createCapability()
    await assert.rejects(
      transaction((client) => authorizeAndCommitInTransaction(client, claims, invocation(claims), store,
        adapter({ failAfterWrite: true }))), /business mutation failed/)
    const lease = await database().query(
      `SELECT used_calls, last_counter FROM tool_leases WHERE lease_id = $1`, [claims.lease_id])
    const effect = await database().query(
      `SELECT writes FROM scope402_kernel_test_effects WHERE lease_id = $1`, [claims.lease_id])
    assert.deepEqual(lease.rows[0], { used_calls: 0, last_counter: 0 })
    assert.equal(effect.rows[0].writes, 0)
  })

  await t.test('same-counter race commits exactly one merchant mutation', async () => {
    const claims = await createCapability()
    const attempt = () => transaction((client) => authorizeAndCommitInTransaction(
      client, claims, invocation(claims), store, adapter()))
    const outcomes = await Promise.allSettled([attempt(), attempt()])
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1)
    const denied = outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult
    assert.equal(denied.reason instanceof LeaseError && denied.reason.code, 'REPLAY_DETECTED')
    const lease = await database().query(
      `SELECT used_calls, last_counter FROM tool_leases WHERE lease_id = $1`, [claims.lease_id])
    const effect = await database().query(
      `SELECT writes FROM scope402_kernel_test_effects WHERE lease_id = $1`, [claims.lease_id])
    assert.deepEqual(lease.rows[0], { used_calls: 1, last_counter: 1 })
    assert.equal(effect.rows[0].writes, 1)
  })

  await t.test('budget exhaustion invokes no additional merchant mutation', async () => {
    const claims = await createCapability()
    await transaction((client) => authorizeAndCommitInTransaction(
      client, claims, invocation(claims), store, adapter()))
    await assert.rejects(
      transaction((client) => authorizeAndCommitInTransaction(
        client, claims, invocation(claims, 2), store, adapter())),
      (error) => error instanceof LeaseError && error.code === 'BUDGET_EXHAUSTED',
    )
    const effect = await database().query(
      `SELECT writes FROM scope402_kernel_test_effects WHERE lease_id = $1`, [claims.lease_id])
    assert.equal(effect.rows[0].writes, 1)
  })

  await t.test('persisted policy mismatch invokes no merchant callback', async () => {
    const claims = await createCapability()
    const changed = { ...claims, policy_hash: `sha256:${'b'.repeat(64)}` }
    let callbacks = 0
    const guardedAdapter = {
      authorizeResourceAction: async () => { callbacks += 1; return true },
      commitBusinessMutation: async () => { callbacks += 1; return 'committed' },
    }
    await assert.rejects(
      transaction((client) => authorizeAndCommitInTransaction(
        client, changed, invocation(changed), store, guardedAdapter)),
      (error) => error instanceof LeaseError && error.code === 'LEASE_REQUIRED',
    )
    assert.equal(callbacks, 0)
  })
})
