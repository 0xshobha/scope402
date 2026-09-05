import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDemoAgentApp } from '../src/demo-app.js'
import { DemoRunService, type DemoRunLimits } from '../src/demo-runs.js'
import type { PreparedScan, ScanResult } from '../src/purchase.js'
import { ephemeralSubject } from '../src/subject.js'
import type { DemoActionResult } from '../src/capability-demo.js'
import { HostedAgentGuard } from '../src/hosted-payment-guard.js'
import { TesseraRunService } from '../src/tessera-runs.js'
import type { PreparedPlot, TesseraPlotResult } from '../src/tessera-purchase.js'

const limits: DemoRunLimits = { runTtlMs: 240_000, perIpRunsPerHour: 3,
  globalRunsPerHour: 50, globalApprovalsPerHour: 20, maxHourlySpendTinybars: 3_000_000n,
  minimumBalanceTinybars: 1_000_000n }

function fixture(): { prepared: PreparedScan; result: ScanResult } {
  const subject = ephemeralSubject()
  const terms = { scheme: 'exact', network: 'hedera:testnet' as const, asset: '0.0.0',
    amount: '50500', payTo: '0.0.12345', maxTimeoutSeconds: 120,
    extra: { feePayer: '0.0.67890' } }
  const prepared = { payer: '0.0.54321', repoUrl: 'https://github.com/owner/repo',
    requestUrl: 'https://auditlab.example/v1/scans',
    paymentUrl: 'https://auditlab.example/v1/scans?quote_id=123e4567-e89b-42d3-a456-426614174000',
    requestBody: '{}', required: { x402Version: 2 as const, resource: {
      url: 'https://auditlab.example/v1/scans?quote_id=123e4567-e89b-42d3-a456-426614174000' },
    accepts: [terms] }, terms, fingerprint: 'sealed', subject,
    quote: { repository: 'owner/repo', commit_sha: 'a'.repeat(40), pricing: {
      base_tinybars: '50000', per_file_tinybars: '500', file_cap: 100,
      files_considered: 1, files_charged: 1, total_tinybars: '50500' } } } satisfies PreparedScan
  const result: ScanResult = { status: 'complete', scan_id: 'scan', repo: 'owner/repo',
    commit_sha: 'a'.repeat(40), findings: [], payment: { payer: '0.0.54321',
      merchant: '0.0.12345', amount_tinybars: '50500', transaction: '0.0.1@1.2',
      hashscan_url: 'https://hashscan.io/testnet/transaction/0.0.1-1-2' },
    lease: { token: 'secret-token-that-is-never-public-123456789', lease_id: 'lease', subject_pubkey: subject.subjectPubkey,
      aud: 'https://auditlab.example/v1/tools', tool_ids: ['finding_details'], max_calls: 3,
      exp: 9999999999, hedera_tx_id: '0.0.1@1.2', scan_id: 'scan' } }
  return { prepared, result }
}

test('HTTP boundary accepts only repo_url and rejects browser payment fields', async () => {
  const data = fixture()
  const app = createDemoAgentApp(new DemoRunService({
    prepare: async () => data.prepared, approve: async () => ({ result: data.result }),
    payerBalanceTinybars: async () => 10_000_000n,
  }, limits), new Set(['https://scope402.onrender.com']))
  const injected = await app.request('/demo/runs', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo_url: data.prepared.repoUrl, amount: '1',
      merchant: '0.0.999', payment: 'payload' }) })
  assert.equal(injected.status, 400)
  assert.equal((await injected.json() as { error: string }).error, 'INVALID_REQUEST')

  const created = await app.request('/demo/runs', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '203.0.113.1',
      'x-forwarded-for': '198.51.100.77', 'x-real-ip': '198.51.100.78' },
    body: JSON.stringify({ repo_url: data.prepared.repoUrl }) })
  assert.equal(created.status, 202)
  const spoofed = await app.request('/demo/runs', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '203.0.113.99',
      'x-forwarded-for': '192.0.2.99', 'x-real-ip': '192.0.2.100' },
    body: JSON.stringify({ repo_url: data.prepared.repoUrl }) })
  assert.equal(spoofed.status, 409)
  assert.equal((await spoofed.json() as { error: string }).error, 'DEMO_RUN_ACTIVE')
  const body = await created.json() as { run: { run_id: string }; run_token: string }
  const approve = await app.request(`/demo/runs/${body.run.run_id}/approve`, { method: 'POST',
    headers: { Authorization: `Bearer ${body.run_token}` },
    body: JSON.stringify({ transaction: 'caller-controlled' }) })
  assert.equal(approve.status, 400)
})

test('Render proxy mode uses Cloudflare client IP and ignores forwarded alternatives', async () => {
  const data = fixture()
  const app = createDemoAgentApp(new DemoRunService({
    prepare: async () => data.prepared, approve: async () => ({ result: data.result }),
    payerBalanceTinybars: async () => 10_000_000n,
  }, limits), new Set(), 'render')
  const create = (headers: Record<string, string>) => app.request('/demo/runs', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ repo_url: data.prepared.repoUrl }),
  })
  assert.equal((await create({ 'cf-connecting-ip': '203.0.113.1',
    'x-real-ip': '192.0.2.11', 'x-forwarded-for': '192.0.2.12, 10.0.0.1' })).status, 202)
  const sameClient = await create({ 'cf-connecting-ip': '203.0.113.1',
    'x-real-ip': '192.0.2.21', 'x-forwarded-for': '192.0.2.22, 10.0.0.2' })
  assert.equal(sameClient.status, 409)
  assert.equal((await sameClient.json() as { error: string }).error, 'DEMO_RUN_ACTIVE')
  assert.equal((await create({ 'cf-connecting-ip': '203.0.113.2',
    'x-real-ip': '192.0.2.31', 'x-forwarded-for': '192.0.2.32, 10.0.0.3' })).status, 202)
})

test('HTTP boundary requires the opaque run capability', async () => {
  const data = fixture()
  const app = createDemoAgentApp(new DemoRunService({
    prepare: async () => data.prepared, approve: async () => ({ result: data.result }),
    payerBalanceTinybars: async () => 10_000_000n,
  }, limits), new Set())
  const response = await app.request('/demo/runs/00000000-0000-4000-8000-000000000000')
  assert.equal(response.status, 404)
})

test('capability action boundary accepts no browser-controlled invocation fields', async () => {
  const data = fixture()
  data.result.findings = [{ id: 'missing-lockfile', severity: 'medium', message: 'Missing lockfile' }]
  const action: DemoActionResult = { action: 'legitimate', verdict: 'ALLOWED', status: 200,
    code: 'FINDING_DETAILS_ALLOWED', message: 'allowed', counter: 1, remaining_calls: 2 }
  const app = createDemoAgentApp(new DemoRunService({
    prepare: async () => data.prepared,
    approve: async () => ({ result: data.result }),
    payerBalanceTinybars: async () => 10_000_000n,
    createCapabilitySession: () => ({ execute: async () => action }),
  }, limits), new Set())
  const created = await app.request('/demo/runs', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.1' },
    body: JSON.stringify({ repo_url: data.prepared.repoUrl }) })
  const body = await created.json() as { run: { run_id: string }; run_token: string }
  await app.request(`/demo/runs/${body.run.run_id}/approve`, { method: 'POST',
    headers: { Authorization: `Bearer ${body.run_token}` }, body: '{}' })
  const injected = await app.request(`/demo/runs/${body.run.run_id}/actions/legitimate`, {
    method: 'POST', headers: { Authorization: `Bearer ${body.run_token}` },
    body: JSON.stringify({ lease: 'caller-controlled', counter: 99 }) })
  assert.equal(injected.status, 400)
  const allowed = await app.request(`/demo/runs/${body.run.run_id}/actions/legitimate`, {
    method: 'POST', headers: { Authorization: `Bearer ${body.run_token}` }, body: '{}' })
  assert.equal(allowed.status, 200)
  assert.equal((await allowed.json() as DemoActionResult).code, 'FINDING_DETAILS_ALLOWED')
  const unknown = await app.request(`/demo/runs/${body.run.run_id}/actions/escalate`, {
    method: 'POST', headers: { Authorization: `Bearer ${body.run_token}` }, body: '{}' })
  assert.equal(unknown.status, 404)
})

test('Tessera HTTP boundary accepts no browser-controlled payment or authority fields', async () => {
  const data = fixture()
  const rootSubject = ephemeralSubject()
  const region = { kind: 'canvas-region' as const, canvasId: 'main', x: 0, y: 0,
    width: 8, height: 8 }
  const prepared = { ...data.prepared, requestUrl: 'https://auditlab.example/v1/plots',
    paymentUrl: 'https://auditlab.example/v1/plots?quote_id=123e4567-e89b-42d3-a456-426614174002',
    subject: rootSubject, quote: { canvas_id: 'main' as const, region,
      pricing: { base_tinybars: '50000', per_call_tinybars: '500', calls: 12 as const,
        total_tinybars: '50500' }, policy_hash: `sha256:${'a'.repeat(64)}` } } as unknown as PreparedPlot
  const result = { status: 'complete' as const, canvas_id: 'main' as const, region,
    payment: data.result.payment as TesseraPlotResult['payment'], lease: {
      token: 'private-root-token-that-is-never-public-123456789', lease_id: 'root',
      subject_pubkey: rootSubject.subjectPubkey, aud: 'https://auditlab.example/v1/tools',
      catalogue_hash: 'catalogue', tool_ids: ['place_pixel'] as ['place_pixel'], max_calls: 12 as const,
      exp: 9_999_999_999, offer_id: '123e4567-e89b-42d3-a456-426614174002',
      hedera_tx_id: data.result.payment.transaction, policy_hash: prepared.quote.policy_hash,
      resource: region, root_lease_id: 'root' } } satisfies TesseraPlotResult
  const guard = new HostedAgentGuard(limits)
  const audit = new DemoRunService({ prepare: async () => data.prepared,
    approve: async () => ({ result: data.result }), payerBalanceTinybars: async () => 10_000_000n,
  }, limits, guard)
  const tessera = new TesseraRunService({
    prepare: async (subject) => ({ ...prepared, subject }), approve: async () => ({ result }),
    payerBalanceTinybars: async () => 10_000_000n,
    createCapabilitySession: () => ({ root: () => ({ lease_id: 'root', subject: rootSubject.subjectPubkey,
      resource: region, tool_ids: ['place_pixel'], max_calls: 12, remaining_calls: 12,
      exp: result.lease.exp, root_lease_id: 'root', payment_quote_id: result.lease.offer_id,
      hedera_tx_id: result.lease.hedera_tx_id, policy_hash: result.lease.policy_hash }),
    child: () => undefined, execute: async () => { throw new Error('not reached') } }),
  }, limits, guard)
  const app = createDemoAgentApp(audit, new Set(), 'none', tessera)
  const injectedCreate = await app.request('/tessera/runs', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: '1' }) })
  assert.equal(injectedCreate.status, 400)
  const created = await app.request('/tessera/runs', { method: 'POST', body: '{}' })
  assert.equal(created.status, 202)
  const run = await created.json() as { run: { run_id: string }; run_token: string }
  const noToken = await app.request(`/tessera/runs/${run.run.run_id}`)
  assert.equal(noToken.status, 404)
  const injectedApproval = await app.request(`/tessera/runs/${run.run.run_id}/approve`, {
    method: 'POST', headers: { Authorization: `Bearer ${run.run_token}` },
    body: JSON.stringify({ payment: 'caller-controlled' }),
  })
  assert.equal(injectedApproval.status, 400)
  const injectedAction = await app.request(`/tessera/runs/${run.run.run_id}/actions/delegate`, {
    method: 'POST', headers: { Authorization: `Bearer ${run.run_token}` },
    body: JSON.stringify({ lease: 'caller-controlled', x: 31 }),
  })
  assert.equal(injectedAction.status, 400)
})
