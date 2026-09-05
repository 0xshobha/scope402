import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PreparedScan, ScanResult } from '../src/purchase.js'
import { DemoRunError, DemoRunService, type DemoRunLimits } from '../src/demo-runs.js'
import type { DemoActionResult } from '../src/capability-demo.js'
import { ephemeralSubject } from '../src/subject.js'

const limits: DemoRunLimits = {
  runTtlMs: 240_000,
  perIpRunsPerHour: 3,
  globalRunsPerHour: 50,
  globalApprovalsPerHour: 20,
  maxHourlySpendTinybars: 3_000_000n,
  minimumBalanceTinybars: 1_000_000n,
}

function prepared(): PreparedScan {
  const subject = ephemeralSubject()
  const terms = { scheme: 'exact', network: 'hedera:testnet' as const, asset: '0.0.0',
    amount: '50500', payTo: '0.0.12345', maxTimeoutSeconds: 120,
    extra: { feePayer: '0.0.67890' } }
  return {
    payer: '0.0.54321', repoUrl: 'https://github.com/owner/repo',
    requestUrl: 'https://auditlab.example/v1/scans',
    paymentUrl: 'https://auditlab.example/v1/scans?quote_id=123e4567-e89b-42d3-a456-426614174000',
    requestBody: '{}', required: { x402Version: 2, resource: {
      url: 'https://auditlab.example/v1/scans?quote_id=123e4567-e89b-42d3-a456-426614174000' },
    accepts: [terms] }, terms, fingerprint: 'sealed', subject,
    quote: { repository: 'owner/repo', commit_sha: 'a'.repeat(40), pricing: {
      base_tinybars: '50000', per_file_tinybars: '500', file_cap: 100,
      files_considered: 1, files_charged: 1, total_tinybars: '50500',
    } },
  }
}

function result(scan: PreparedScan): ScanResult {
  return {
    status: 'complete', scan_id: 'scan-id', repo: scan.quote.repository,
    commit_sha: scan.quote.commit_sha,
    findings: [{ id: 'missing-lockfile', severity: 'medium', message: 'Missing lockfile' }],
    payment: { payer: scan.payer, merchant: scan.terms.payTo,
      amount_tinybars: scan.terms.amount, transaction: '0.0.67890@1.2',
      hashscan_url: 'https://hashscan.io/testnet/transaction/0.0.67890-1-2' },
    lease: { token: 'private-lease-token-that-is-never-public-123456789', lease_id: 'lease-id',
      subject_pubkey: scan.subject.subjectPubkey, aud: 'https://auditlab.example/v1/tools',
      tool_ids: ['finding_details'], max_calls: 3, exp: 9999999999,
      hedera_tx_id: '0.0.67890@1.2', scan_id: 'scan-id' },
  }
}

test('preparation returns a real quote-shaped run and does not approve payment', async () => {
  let approvals = 0
  const scan = prepared()
  const service = new DemoRunService({
    prepare: async () => scan,
    approve: async () => { approvals += 1; return { result: result(scan) } },
    payerBalanceTinybars: async () => 10_000_000n,
  }, limits)
  const created = await service.create(scan.repoUrl, '203.0.113.1')
  assert.equal(created.run.state, 'PAYMENT_REQUIRED')
  assert.equal(created.run.quote.payer, '0.0.54321')
  assert.equal(created.run.quote.merchant, '0.0.12345')
  assert.equal(approvals, 0)
})

test('concurrent and repeated approval perform exactly one payment and return the same result', async () => {
  let approvals = 0
  const scan = prepared()
  let release!: () => void
  const waiting = new Promise<void>((resolve) => { release = resolve })
  const service = new DemoRunService({
    prepare: async () => scan,
    approve: async () => { approvals += 1; await waiting; return { result: result(scan) } },
    payerBalanceTinybars: async () => 10_000_000n,
  }, limits)
  const created = await service.create(scan.repoUrl, '203.0.113.1')
  const first = service.approve(created.run.run_id, created.run_token)
  const second = service.approve(created.run.run_id, created.run_token)
  release()
  const [a, b] = await Promise.all([first, second])
  assert.equal(approvals, 1)
  assert.deepEqual(a, b)
  assert.deepEqual(await service.approve(created.run.run_id, created.run_token), a)
  assert.equal(JSON.stringify(a).includes('private-lease-token'), false)
  assert.equal('unexpected' in (a.result?.lease ?? {}), false)
})

test('unknown, unauthorized, and expired run capabilities are rejected', async () => {
  let now = 1_000
  const scan = prepared()
  const service = new DemoRunService({
    prepare: async () => scan, approve: async () => ({ result: result(scan) }),
    payerBalanceTinybars: async () => 10_000_000n, now: () => now,
  }, { ...limits, runTtlMs: 100 })
  const created = await service.create(scan.repoUrl, '203.0.113.1')
  assert.throws(() => service.get('00000000-0000-4000-8000-000000000000', 'bad'),
    (error) => error instanceof DemoRunError && error.status === 404)
  assert.throws(() => service.get(created.run.run_id, 'bad'),
    (error) => error instanceof DemoRunError && error.status === 404)
  now = 1_101
  assert.throws(() => service.approve(created.run.run_id, created.run_token),
    (error) => error instanceof DemoRunError && error.status === 410)
})

test('balance and global spend limits fail closed before payment execution', async () => {
  let approvals = 0
  const scan = prepared()
  const service = new DemoRunService({
    prepare: async () => scan,
    approve: async () => { approvals += 1; return { result: result(scan) } },
    payerBalanceTinybars: async () => 1_000_000n,
  }, limits)
  const created = await service.create(scan.repoUrl, '203.0.113.1')
  await assert.rejects(service.approve(created.run.run_id, created.run_token),
    (error) => error instanceof DemoRunError && error.code === 'DEMO_BALANCE_FLOOR')
  assert.equal(approvals, 0)
})

test('capability actions are private, ordered, idempotent, and update the public budget', async () => {
  const scan = prepared()
  let executions = 0
  const actionResult = (action: DemoActionResult['action']): DemoActionResult => ({
    action,
    verdict: action === 'legitimate' ? 'ALLOWED' : 'DENIED',
    status: action === 'legitimate' ? 200 : action === 'expire' ? 410 : 403,
    code: action === 'legitimate' ? 'FINDING_DETAILS_ALLOWED' :
      action === 'wrong-key' ? 'SUBJECT_KEY_MISMATCH' :
        action === 'replay' ? 'REPLAY_DETECTED' : 'LEASE_EXPIRED',
    message: action,
    counter: action === 'expire' ? 2 : 1,
    remaining_calls: action === 'wrong-key' ? 3 : 2,
  })
  const service = new DemoRunService({
    prepare: async () => scan,
    approve: async () => ({ result: result(scan) }),
    payerBalanceTinybars: async () => 10_000_000n,
    createCapabilitySession: () => ({ execute: async (action) => {
      executions += 1
      return actionResult(action)
    } }),
  }, limits)
  const created = await service.create(scan.repoUrl, '203.0.113.1')
  await service.approve(created.run.run_id, created.run_token)
  assert.throws(() => service.action(created.run.run_id, created.run_token, 'replay'),
    (error) => error instanceof DemoRunError && error.code === 'DEMO_ACTION_ORDER')
  const wrongKey = await service.action(created.run.run_id, created.run_token, 'wrong-key')
  assert.equal(wrongKey.remaining_calls, 3)
  const [first, second] = await Promise.all([
    service.action(created.run.run_id, created.run_token, 'legitimate'),
    service.action(created.run.run_id, created.run_token, 'legitimate'),
  ])
  assert.deepEqual(first, second)
  assert.equal(executions, 2)
  assert.equal(service.get(created.run.run_id, created.run_token).result?.lease.remaining_calls, 2)
  assert.equal(JSON.stringify(service.get(created.run.run_id, created.run_token)).includes(result(scan).lease.token), false)
  assert.equal((await service.action(created.run.run_id, created.run_token, 'replay')).code, 'REPLAY_DETECTED')
  assert.equal((await service.action(created.run.run_id, created.run_token, 'expire')).status, 410)
})

test('clean scans disable finding-specific capability actions', async () => {
  const scan = prepared()
  const clean = result(scan)
  clean.findings = []
  const service = new DemoRunService({
    prepare: async () => scan, approve: async () => ({ result: clean }),
    payerBalanceTinybars: async () => 10_000_000n,
  }, limits)
  const created = await service.create(scan.repoUrl, '203.0.113.1')
  await service.approve(created.run.run_id, created.run_token)
  assert.throws(() => service.action(created.run.run_id, created.run_token, 'legitimate'),
    (error) => error instanceof DemoRunError && error.code === 'DEMO_NO_FINDING')
})
