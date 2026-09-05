import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCapabilitySession } from '../src/capability-demo.js'
import type { PreparedScan, ScanResult } from '../src/purchase.js'
import { ephemeralSubject } from '../src/subject.js'

function fixture() {
  const subject = ephemeralSubject()
  const prepared = {
    payer: '0.0.54321', repoUrl: 'https://github.com/owner/repo',
    requestUrl: 'https://auditlab.example/v1/scans',
    paymentUrl: 'https://auditlab.example/v1/scans?quote_id=123e4567-e89b-42d3-a456-426614174000',
    requestBody: '{}', required: { x402Version: 2 as const, resource: {
      url: 'https://auditlab.example/v1/scans?quote_id=123e4567-e89b-42d3-a456-426614174000' },
    accepts: [] }, terms: { scheme: 'exact', network: 'hedera:testnet' as const, asset: '0.0.0',
      amount: '50500', payTo: '0.0.12345', maxTimeoutSeconds: 120,
      extra: { feePayer: '0.0.67890' } }, fingerprint: 'sealed', subject,
    quote: { repository: 'owner/repo', commit_sha: 'a'.repeat(40), pricing: {
      base_tinybars: '50000', per_file_tinybars: '500', file_cap: 100,
      files_considered: 1, files_charged: 1, total_tinybars: '50500' } },
  } satisfies PreparedScan
  const result: ScanResult = {
    status: 'complete', scan_id: 'scan', repo: 'owner/repo', commit_sha: 'a'.repeat(40),
    findings: [{ id: 'missing-lockfile', severity: 'medium', message: 'Missing lockfile' }],
    payment: { payer: prepared.payer, merchant: prepared.terms.payTo,
      amount_tinybars: prepared.terms.amount, transaction: '0.0.1@1.2',
      hashscan_url: 'https://hashscan.io/testnet/transaction/0.0.1-1-2' },
    lease: { token: 'private-lease-token-that-must-not-reach-the-browser', lease_id: 'lease',
      subject_pubkey: subject.subjectPubkey, aud: 'https://auditlab.example/v1/tools',
      tool_ids: ['finding_details'], max_calls: 3, exp: 9_999_999_999,
      hedera_tx_id: '0.0.1@1.2', scan_id: 'scan' },
  }
  return { prepared, result }
}

test('capability session drives one allowed call and three real denial shapes', async () => {
  const { prepared, result } = fixture()
  const bodies: string[] = []
  const secret = 's'.repeat(32)
  const request: typeof fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/expire')) {
      assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${secret}`)
      return Response.json({ status: 'expired' })
    }
    const body = String(init?.body)
    bodies.push(body)
    const subject = JSON.parse(Buffer.from(JSON.parse(body).signature.split('.')[0], 'base64url').toString())
      .subject_pubkey
    if (bodies.length === 1) {
      assert.notEqual(subject, prepared.subject.subjectPubkey)
      return Response.json({ error: 'SUBJECT_KEY_MISMATCH', message: 'wrong key' }, { status: 403 })
    }
    if (bodies.length === 2) {
      assert.equal(subject, prepared.subject.subjectPubkey)
      return Response.json({ lease_id: 'lease', counter: 1, finding: result.findings[0] })
    }
    if (bodies.length === 3) {
      assert.equal(body, bodies[1])
      return Response.json({ error: 'REPLAY_DETECTED', message: 'replayed' }, { status: 403 })
    }
    return Response.json({ error: 'LEASE_EXPIRED', message: 'expired' }, { status: 410 })
  }
  const session = createCapabilitySession(prepared, result, secret, request)
  assert.equal((await session.execute('wrong-key')).code, 'SUBJECT_KEY_MISMATCH')
  const allowed = await session.execute('legitimate')
  assert.equal(allowed.status, 200)
  assert.equal(allowed.remaining_calls, 2)
  assert.equal((await session.execute('replay')).code, 'REPLAY_DETECTED')
  assert.equal((await session.execute('expire')).code, 'LEASE_EXPIRED')
  assert.equal(bodies.length, 4)
})

test('clean scans cannot create a finding-specific capability session', () => {
  const { prepared, result } = fixture()
  result.findings = []
  assert.throws(() => createCapabilitySession(prepared, result, 's'.repeat(32)),
    /requires a real scan finding/)
})
