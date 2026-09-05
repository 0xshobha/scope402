import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DemoRunService, type DemoRunLimits } from '../src/demo-runs.js'
import { HostedAgentGuard } from '../src/hosted-payment-guard.js'
import { ExactPaymentDeliveryError } from '../src/payment-client.js'
import { ephemeralSubject } from '../src/subject.js'
import type { TesseraActionName, TesseraActionResult } from '../src/tessera-capability.js'
import { TesseraRunService } from '../src/tessera-runs.js'
import type { PreparedPlot, TesseraPlotResult } from '../src/tessera-purchase.js'
import type { PreparedScan, ScanResult } from '../src/purchase.js'

const limits: DemoRunLimits = { runTtlMs: 240_000, perIpRunsPerHour: 3,
  globalRunsPerHour: 50, globalApprovalsPerHour: 20,
  maxHourlySpendTinybars: 3_000_000n, minimumBalanceTinybars: 1_000_000n }

function fixture() {
  const subject = ephemeralSubject()
  const terms = { scheme: 'exact', network: 'hedera:testnet' as const, asset: '0.0.0',
    amount: '56000', payTo: '0.0.12345', maxTimeoutSeconds: 120,
    extra: { feePayer: '0.0.67890' } }
  const region = { kind: 'canvas-region' as const, canvasId: 'main', x: 0, y: 0,
    width: 8, height: 8 }
  const prepared: PreparedPlot = {
    payer: '0.0.54321', requestUrl: 'https://auditlab.example/v1/plots',
    paymentUrl: 'https://auditlab.example/v1/plots?quote_id=123e4567-e89b-42d3-a456-426614174000',
    requestBody: '{}', required: { x402Version: 2, resource: {
      url: 'https://auditlab.example/v1/plots?quote_id=123e4567-e89b-42d3-a456-426614174000' },
    accepts: [terms] }, terms, fingerprint: 'sealed', subject,
    quote: { canvas_id: 'main', region, pricing: { base_tinybars: '50000',
      per_call_tinybars: '500', calls: 12, total_tinybars: '56000' },
    policy_hash: `sha256:${'a'.repeat(64)}` },
  }
  const result: TesseraPlotResult = {
    status: 'complete', canvas_id: 'main', region,
    payment: { payer: prepared.payer, merchant: terms.payTo, amount_tinybars: terms.amount,
      transaction: '0.0.67890@1.2',
      hashscan_url: 'https://hashscan.io/testnet/transaction/0.0.67890-1-2' },
    lease: { token: 'root-private-token-that-is-never-public-123456789', lease_id: 'root-lease',
      subject_pubkey: subject.subjectPubkey, aud: 'https://auditlab.example/v1/tools',
      catalogue_hash: 'catalogue', tool_ids: ['place_pixel'], max_calls: 12,
      exp: 9_999_999_999, offer_id: '123e4567-e89b-42d3-a456-426614174000',
      hedera_tx_id: '0.0.67890@1.2', policy_hash: prepared.quote.policy_hash,
      resource: region, root_lease_id: 'root-lease' },
  }
  return { prepared, result }
}

function service(overrides: Partial<{
  approve(prepared: PreparedPlot): Promise<{ result: TesseraPlotResult }>
  balance(): Promise<bigint>
}> = {}, guard = new HostedAgentGuard(limits)) {
  const data = fixture()
  let executions = 0
  const child = { lease_id: 'child-lease', subject: 'worker-public',
    resource: { ...data.prepared.quote.region, x: 2, y: 2, width: 4, height: 4 },
    tool_ids: ['place_pixel'] as ['place_pixel'], max_calls: 1, remaining_calls: 1,
    exp: 9_999_999_998, root_lease_id: 'root-lease', parent_lease_id: 'root-lease',
    payment_quote_id: data.result.lease.offer_id, hedera_tx_id: data.result.lease.hedera_tx_id,
    policy_hash: `sha256:${'b'.repeat(64)}` }
  return { data, get executions() { return executions }, instance: new TesseraRunService({
    prepare: async (subject) => ({ ...data.prepared, subject,
      quote: { ...data.prepared.quote }, requestBody: '{}' }),
    approve: overrides.approve ?? (async () => ({ result: data.result })),
    payerBalanceTinybars: overrides.balance ?? (async () => 10_000_000n),
    createCapabilitySession: (_prepared, result) => ({
      root: () => ({ lease_id: result.lease.lease_id, subject: 'p256:fixtureprincipal',
        resource: result.region, tool_ids: ['place_pixel'], max_calls: 12, remaining_calls: 12,
        exp: result.lease.exp, root_lease_id: result.lease.root_lease_id,
        payment_quote_id: result.lease.offer_id, hedera_tx_id: result.lease.hedera_tx_id,
        policy_hash: result.lease.policy_hash }),
      child: () => executions ? child : undefined,
      execute: async (action: TesseraActionName) => {
        executions += 1
        const codes = { delegate: 'CAPABILITY_DELEGATED', 'place-outside': 'OUT_OF_SCOPE',
          'wrong-key': 'SUBJECT_KEY_MISMATCH', 'place-inside': 'PIXEL_PLACED',
          replay: 'REPLAY_DETECTED', expire: 'LEASE_EXPIRED' } as const
        return { sequence: executions, at: new Date().toISOString(), action,
          verdict: ['delegate', 'place-inside'].includes(action) ? 'ALLOWED' : 'DENIED',
          status: action === 'expire' ? 410 : ['delegate', 'place-inside'].includes(action) ? 200 : 403,
          code: codes[action], remaining_calls: action === 'delegate' ? 1 : 0,
          message: action } as TesseraActionResult
      },
    }),
  }, limits, guard) }
}

test('Tessera preparation moves no money and exposes no authority secrets', async () => {
  let approvals = 0
  const setup = service({ approve: async () => { approvals += 1; return { result: fixture().result } } })
  const created = await setup.instance.create('203.0.113.1')
  assert.equal(created.run.state, 'PAYMENT_REQUIRED')
  assert.equal(approvals, 0)
  assert.equal(created.run.quote.pricing.total_tinybars, '56000')
  const publicRun = JSON.stringify(created.run)
  assert.equal(publicRun.includes('private-token'), false)
  assert.equal(publicRun.includes('signature'), false)
  assert.equal(publicRun.includes(setup.data.prepared.subject.subjectPubkey), false)
  assert.equal(publicRun.includes('PAYMENT-SIGNATURE'), false)
  assert.equal(publicRun.includes('requestBody'), false)
})

test('Tessera approval is private, concurrent-idempotent, and sanitized', async () => {
  let approvals = 0
  let release!: () => void
  const waiting = new Promise<void>((resolve) => { release = resolve })
  const setup = service({ approve: async () => {
    approvals += 1; await waiting; return { result: setup.data.result }
  } })
  const created = await setup.instance.create('203.0.113.1')
  assert.throws(() => setup.instance.get(created.run.run_id, 'wrong'))
  const first = setup.instance.approve(created.run.run_id, created.run_token)
  const second = setup.instance.approve(created.run.run_id, created.run_token)
  release()
  const [a, b] = await Promise.all([first, second])
  assert.equal(approvals, 1)
  assert.deepEqual(a, b)
  assert.equal(a.state, 'ROOT_ACTIVE')
  assert.equal(a.root?.remaining_calls, 12)
  const approvedRun = JSON.stringify(a)
  assert.equal(approvedRun.includes(setup.data.result.lease.token), false)
  assert.equal(approvedRun.includes(setup.data.result.lease.subject_pubkey), false)
})

test('ambiguous Tessera payment delivery retries the same attempt without consuming another quota', async () => {
  let approvals = 0
  const strictLimits = { ...limits, globalApprovalsPerHour: 1, maxHourlySpendTinybars: 56_000n }
  const guard = new HostedAgentGuard(strictLimits)
  const setup = service({ approve: async (prepared) => {
    approvals += 1
    const mutable = prepared as PreparedPlot & { paymentSignature?: string }
    if (approvals === 1) {
      mutable.paymentSignature = 'same-signed-hedera-transaction'
      throw new ExactPaymentDeliveryError('response lost after broadcast')
    }
    assert.equal(mutable.paymentSignature, 'same-signed-hedera-transaction')
    return { result: setup.data.result }
  } }, guard)
  const created = await setup.instance.create('203.0.113.1')
  await assert.rejects(setup.instance.approve(created.run.run_id, created.run_token),
    /ambiguous|same signed/i)
  assert.equal(setup.instance.get(created.run.run_id, created.run_token).state, 'PAYMENT_RECOVERY')
  const recovered = await setup.instance.approve(created.run.run_id, created.run_token)
  assert.equal(recovered.state, 'ROOT_ACTIVE')
  assert.equal(approvals, 2)
})

test('Tessera actions enforce order and are idempotent', async () => {
  const setup = service()
  const created = await setup.instance.create('203.0.113.1')
  await setup.instance.approve(created.run.run_id, created.run_token)
  assert.throws(() => setup.instance.action(created.run.run_id, created.run_token, 'place-inside'),
    /Run/)
  const delegate = await setup.instance.action(created.run.run_id, created.run_token, 'delegate')
  const duplicate = await setup.instance.action(created.run.run_id, created.run_token, 'delegate')
  assert.deepEqual(delegate, duplicate)
  assert.equal(setup.executions, 1)
  for (const action of ['place-outside', 'wrong-key', 'place-inside', 'replay', 'expire'] as const) {
    await setup.instance.action(created.run.run_id, created.run_token, action)
  }
  const run = setup.instance.get(created.run.run_id, created.run_token)
  assert.equal(run.state, 'COMPLETE')
  assert.equal(run.actions.length, 6)
  assert.equal(run.last_action?.code, 'LEASE_EXPIRED')
})

test('a failed Tessera action can be recovered instead of caching rejection forever', async () => {
  const data = fixture()
  let executions = 0
  const instance = new TesseraRunService({
    prepare: async (subject) => ({ ...data.prepared, subject }),
    approve: async () => ({ result: data.result }),
    payerBalanceTinybars: async () => 10_000_000n,
    createCapabilitySession: () => ({
      root: () => ({ lease_id: data.result.lease.lease_id, subject: 'p256:principal',
        resource: data.result.region, tool_ids: ['place_pixel'], max_calls: 12,
        remaining_calls: 12, exp: data.result.lease.exp,
        root_lease_id: data.result.lease.root_lease_id,
        payment_quote_id: data.result.lease.offer_id,
        hedera_tx_id: data.result.lease.hedera_tx_id,
        policy_hash: data.result.lease.policy_hash }),
      child: () => undefined,
      execute: async (action) => {
        executions += 1
        if (executions === 1) throw new TypeError('response lost')
        return { sequence: 1, at: new Date().toISOString(), action,
          verdict: 'ALLOWED', status: 200, code: 'CAPABILITY_DELEGATED',
          message: 'recovered', remaining_calls: 1 }
      },
    }),
  }, limits, new HostedAgentGuard(limits))
  const created = await instance.create('203.0.113.9')
  await instance.approve(created.run.run_id, created.run_token)
  await assert.rejects(instance.action(created.run.run_id, created.run_token, 'delegate'),
    /response lost/)
  const recovered = await instance.action(created.run.run_id, created.run_token, 'delegate')
  assert.equal(recovered.code, 'CAPABILITY_DELEGATED')
  assert.equal(executions, 2)
})

test('AuditLab and Tessera share one active-run and payment budget', async () => {
  const sharedLimits = { ...limits, globalApprovalsPerHour: 1, maxHourlySpendTinybars: 56_000n }
  const guard = new HostedAgentGuard(sharedLimits)
  const tessera = service({}, guard)
  const scanSubject = ephemeralSubject()
  const scanTerms = { scheme: 'exact', network: 'hedera:testnet' as const, asset: '0.0.0',
    amount: '50500', payTo: '0.0.12345', maxTimeoutSeconds: 120,
    extra: { feePayer: '0.0.67890' } }
  const preparedScan = { payer: '0.0.54321', repoUrl: 'https://github.com/owner/repo',
    requestUrl: 'https://auditlab.example/v1/scans',
    paymentUrl: 'https://auditlab.example/v1/scans?quote_id=123e4567-e89b-42d3-a456-426614174001',
    requestBody: '{}', required: { x402Version: 2 as const, resource: {
      url: 'https://auditlab.example/v1/scans?quote_id=123e4567-e89b-42d3-a456-426614174001' },
    accepts: [scanTerms] }, terms: scanTerms, fingerprint: 'sealed', subject: scanSubject,
    quote: { repository: 'owner/repo', commit_sha: 'a'.repeat(40), pricing: {
      base_tinybars: '50000', per_file_tinybars: '500', file_cap: 100,
      files_considered: 1, files_charged: 1, total_tinybars: '50500' } } } satisfies PreparedScan
  const scanResult = { status: 'complete', scan_id: 'scan', repo: 'owner/repo',
    commit_sha: 'a'.repeat(40), findings: [], payment: { payer: '0.0.54321',
      merchant: '0.0.12345', amount_tinybars: '50500', transaction: '0.0.1@1.2',
      hashscan_url: 'https://hashscan.io/testnet/transaction/0.0.1-1-2' },
    lease: { token: 'private-token-that-is-long-enough-123456789', lease_id: 'lease',
      subject_pubkey: scanSubject.subjectPubkey, aud: 'https://auditlab.example/v1/tools',
      tool_ids: ['finding_details'], max_calls: 3, exp: 9_999_999_999,
      hedera_tx_id: '0.0.1@1.2', scan_id: 'scan' } } satisfies ScanResult
  const audit = new DemoRunService({ prepare: async () => preparedScan,
    approve: async () => ({ result: scanResult }), payerBalanceTinybars: async () => 10_000_000n,
  }, sharedLimits, guard)
  const auditRun = await audit.create(preparedScan.repoUrl, '203.0.113.1')
  await assert.rejects(tessera.instance.create('203.0.113.1'), /active/)
  await audit.approve(auditRun.run.run_id, auditRun.run_token)
  const plot = await tessera.instance.create('203.0.113.1')
  assert.throws(() => tessera.instance.approve(plot.run.run_id, plot.run_token), /spend limit/)
})
