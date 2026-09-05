import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { PaymentRequirements, SettleResponse } from '@x402/core/types'
import { closeDatabase, database, initializeDatabase } from '../src/db.js'
import { createQuote, loadQuote, type Pricing } from '../src/payments.js'
import { fulfillPaidScan, ScanJobError } from '../src/scan-jobs.js'
import { scope402Extension } from '../src/scope-extension.js'
import { prepareLease } from '../src/leases.js'

const service = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const subject = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const subjectPubkey = subject.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
const requirements: PaymentRequirements = {
  scheme: 'exact', network: 'hedera:testnet', asset: '0.0.0', amount: '50500',
  payTo: '0.0.8258555', maxTimeoutSeconds: 120, extra: { feePayer: '0.0.7162784' },
}
const snapshot = {
  repo: '0xshobha/scope402', commit_sha: 'a'.repeat(40), root_files: ['package.json'],
}
const pricing: Pricing = {
  base_tinybars: '50000', per_file_tinybars: '500', file_cap: 100,
  files_considered: 1, files_charged: 1, total_tinybars: '50500',
}

function transactionId() {
  return `0.0.7162784@${Math.floor(Date.now() / 1000)}.${String(Math.random()).slice(2, 11).padEnd(9, '0')}`
}

async function purchase(repoUrl = 'https://github.com/0xshobha/scope402') {
  const quote = await createQuote(repoUrl, subjectPubkey,
    'http://127.0.0.1:3000/v1/scans', requirements, snapshot, pricing,
    scope402Extension(subjectPubkey, snapshot, 'http://127.0.0.1:3000/v1/tools'))
  const stored = await loadQuote(quote.quoteId, repoUrl, subjectPubkey)
  const transaction = transactionId()
  const receipt: SettleResponse = {
    success: true, network: 'hedera:testnet', transaction, payer: '0.0.8258066',
  }
  await database().query(
    `INSERT INTO payment_redemptions (transaction_id, quote_id, status, payer, receipt)
     VALUES ($1, $2, 'settled', $3, $4)`,
    [transaction, quote.quoteId, receipt.payer, JSON.stringify(receipt)],
  )
  return { transactionId: transaction, quoteId: quote.quoteId, repoUrl, subjectPubkey,
    requirements, receipt, policy: stored.scope402Extension!.scope402.info }
}

function successfulScan() {
  return Promise.resolve({
    scan_id: randomUUID(), repo: '0xshobha/scope402', commit_sha: 'a'.repeat(40),
    findings: [{ id: 'missing-lockfile' as const, severity: 'medium' as const, message: 'Missing lockfile' }],
  })
}

test('recovers durable paid scan fulfillment', async (t) => {
  process.env.TOOL_LEASE_PRIVATE_KEY = service.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  await initializeDatabase()
  t.after(async () => {
    await database().query('DELETE FROM scan_jobs; DELETE FROM tool_leases; DELETE FROM payment_redemptions; DELETE FROM payment_quotes')
    await closeDatabase()
  })

  await t.test('retries failed work without creating another payment', async () => {
    const input = await purchase()
    let scans = 0
    await assert.rejects(fulfillPaidScan(input, async () => {
      scans += 1
      throw new Error('GitHub unavailable')
    }), (error: unknown) => error instanceof ScanJobError && error.code === 'SCAN_RETRYABLE')
    const failed = await database().query(
      `SELECT status FROM scan_jobs WHERE transaction_id = $1`, [input.transactionId])
    assert.equal(failed.rows[0].status, 'retryable_failed')

    const completed = await fulfillPaidScan(input, async () => {
      scans += 1
      return successfulScan()
    })
    assert.equal(completed.status, 'complete')
    assert.equal(completed.lease.policy_hash, input.policy?.policyHash)
    assert.equal(completed.lease.aud, input.policy?.audience)
    assert.equal(scans, 2)
    assert.equal((await database().query(
      `SELECT policy_hash FROM tool_leases WHERE hedera_tx_id = $1`,
      [input.transactionId])).rows[0].policy_hash, input.policy?.policyHash)
    assert.equal((await database().query(
      `SELECT count(*)::int AS count FROM payment_redemptions WHERE transaction_id = $1`,
      [input.transactionId])).rows[0].count, 1)
  })

  await t.test('recovers after quote expiry and returns the exact cached lease', async () => {
    const input = await purchase()
    await database().query(`UPDATE payment_quotes SET expires_at = now() - interval '1 minute' WHERE quote_id = $1`,
      [input.quoteId])
    await assert.rejects(loadQuote(input.quoteId, input.repoUrl, input.subjectPubkey), /expired/)
    assert.equal((await loadQuote(input.quoteId, input.repoUrl, input.subjectPubkey, true)).resourceUrl.includes(input.quoteId), true)

    let scans = 0
    const first = await fulfillPaidScan(input, async () => {
      scans += 1
      return successfulScan()
    })
    const cached = await fulfillPaidScan(input, async () => {
      scans += 1
      return successfulScan()
    })
    assert.deepEqual(cached, first)
    assert.equal(cached.lease.token, first.lease.token)
    assert.equal(scans, 1)
  })

  await t.test('allows one concurrent fulfillment and one lease', async () => {
    const input = await purchase()
    let release!: () => void
    const wait = new Promise<void>((resolve) => { release = resolve })
    let started!: () => void
    const running = new Promise<void>((resolve) => { started = resolve })
    let scans = 0
    const first = fulfillPaidScan(input, async () => {
      scans += 1
      started()
      await wait
      return successfulScan()
    })
    await running
    await assert.rejects(fulfillPaidScan(input, successfulScan),
      (error: unknown) => error instanceof ScanJobError && error.code === 'SCAN_IN_PROGRESS')
    release()
    await first
    assert.equal(scans, 1)
    assert.equal((await database().query(
      `SELECT count(*)::int AS count FROM tool_leases WHERE hedera_tx_id = $1`,
      [input.transactionId])).rows[0].count, 1)
  })

  await t.test('reclaims stale running work', async () => {
    const input = await purchase()
    await database().query(
      `INSERT INTO scan_jobs (transaction_id, quote_id, status, run_started_at)
       VALUES ($1, $2, 'running', now() - interval '3 minutes')`,
      [input.transactionId, input.quoteId],
    )
    assert.equal((await fulfillPaidScan(input, successfulScan)).status, 'complete')
  })

  await t.test('cannot bind a transaction to another quote', async () => {
    const input = await purchase()
    await database().query(
      `INSERT INTO scan_jobs (transaction_id, quote_id, status) VALUES ($1, $2, 'pending')`,
      [input.transactionId, input.quoteId],
    )
    const other = await createQuote(input.repoUrl, input.subjectPubkey,
      'http://127.0.0.1:3000/v1/scans', requirements, snapshot, pricing,
      scope402Extension(input.subjectPubkey, snapshot, 'http://127.0.0.1:3000/v1/tools'))
    await assert.rejects(fulfillPaidScan({ ...input, quoteId: other.quoteId }, successfulScan), /another scan job/)
  })

  await t.test('does not persist a lease when signing fails', async () => {
    const input = await purchase()
    const key = process.env.TOOL_LEASE_PRIVATE_KEY
    const keyPath = process.env.TOOL_LEASE_PRIVATE_KEY_PATH
    delete process.env.TOOL_LEASE_PRIVATE_KEY
    delete process.env.TOOL_LEASE_PRIVATE_KEY_PATH
    await assert.rejects(fulfillPaidScan(input, successfulScan),
      (error: unknown) => error instanceof ScanJobError && error.code === 'SCAN_RETRYABLE')
    process.env.TOOL_LEASE_PRIVATE_KEY = key
    if (keyPath === undefined) delete process.env.TOOL_LEASE_PRIVATE_KEY_PATH
    else process.env.TOOL_LEASE_PRIVATE_KEY_PATH = keyPath
    assert.equal((await database().query(
      `SELECT count(*)::int AS count FROM tool_leases WHERE hedera_tx_id = $1`,
      [input.transactionId])).rows[0].count, 0)
    assert.equal((await fulfillPaidScan(input, successfulScan)).status, 'complete')
  })

  await t.test('refuses lease issuance from an unvalidated policy hash', async () => {
    const input = await purchase()
    const policy = { ...input.policy!, policyHash: `sha256:${'0'.repeat(64)}` }
    await assert.rejects(prepareLease(input.subjectPubkey, await successfulScan(),
      input.transactionId, input.quoteId, policy), /policy is invalid/)
  })
})
