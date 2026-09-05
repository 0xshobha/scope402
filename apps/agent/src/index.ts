import { createHash } from 'node:crypto'
import { canonicalJson } from './canonical.js'
import { approveScanPurchase, prepareScanPurchase, type PayerConfig } from './purchase.js'
import { attackerSubject, persistentSubject } from './subject.js'

async function toolCall(url: URL, body: string) {
  return fetch(new URL('/v1/tools/finding_details', url), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    redirect: 'error', signal: AbortSignal.timeout(20_000),
  })
}

async function requireDenial(response: Response, expectedStatus: number, expectedError: string) {
  const body: unknown = await response.json().catch(() => null)
  const error = body && typeof body === 'object' && 'error' in body ? String(body.error) : 'UNKNOWN'
  if (response.status !== expectedStatus || error !== expectedError) {
    throw new Error(`Expected HTTP ${expectedStatus} ${expectedError}; API returned HTTP ${response.status}: ${error}`)
  }
  console.log(`[ATTACK] ${expectedError} — DENIED`)
}

async function run() {
  const payer = process.env.HEDERA_PAYER_ACCOUNT_ID
  const merchant = process.env.HEDERA_MERCHANT_ACCOUNT_ID
  const secret = process.env.HEDERA_PAYER_PRIVATE_KEY
  if (!payer || !merchant || !secret) throw new Error('Configure the payer account, payer private key, and merchant account')
  const repo = process.argv[2]
  if (!repo) throw new Error('Pass a public GitHub repository URL as the argument')
  const demo = process.argv.includes('--demo')
  const baseUrl = new URL(process.env.AUDITLAB_URL ?? 'http://127.0.0.1:3000')
  if (baseUrl.protocol !== 'https:' &&
      !(baseUrl.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(baseUrl.hostname))) {
    throw new Error('Use HTTPS, or HTTP on localhost only')
  }
  const config: PayerConfig = { auditLabUrl: baseUrl, payer, merchant,
    maxPaymentTinybars: process.env.MAX_PAYMENT_TINYBARS ?? '150000', payerPrivateKey: secret }
  const prepared = await prepareScanPurchase(config, repo, await persistentSubject())
  const url = new URL(prepared.requestUrl)
  console.log(`Discovered paid resource: ${url.pathname}`)
  console.log(`402 received: ${prepared.terms.amount} tinybars from ${payer} to ${merchant}`)
  console.log('Hedera transfer policy approved; signing and settling')
  const { receipt, result } = await approveScanPurchase(config, prepared)
  console.log(`Settled transaction: ${receipt.transaction}`)
  console.log(JSON.stringify(result))
  const findingId = result.findings.find((finding) => typeof finding.id === 'string')?.id
  if (!findingId) {
    console.log('[SCAN] COMPLETE — no findings')
    return
  }
  const args = { finding_id: findingId }
  const invocation = (counter: number) => ({
    lease_id: result.lease.lease_id, tool_id: 'finding_details', counter,
    args_hash: createHash('sha256').update(canonicalJson(args)).digest('hex'),
    issued_at: Math.floor(Date.now() / 1000),
  })
  if (demo) {
    const attacker = attackerSubject()
    const wrongKeyBody = JSON.stringify({ lease: result.lease.token, args, counter: 1,
      signature: attacker.sign(invocation(1)) })
    await requireDenial(await toolCall(url, wrongKeyBody), 403, 'SUBJECT_KEY_MISMATCH')
  }
  const legitimateBody = JSON.stringify({ lease: result.lease.token, args, counter: 1,
    signature: prepared.subject.sign(invocation(1)) })
  const toolResponse = await toolCall(url, legitimateBody)
  if (!toolResponse.ok) throw new Error(`finding_details returned HTTP ${toolResponse.status}`)
  console.log(`[CALL] ALLOWED — ${JSON.stringify(await toolResponse.json())}`)
  if (!demo) return
  await requireDenial(await toolCall(url, legitimateBody), 403, 'REPLAY_DETECTED')
  const demoSecret = process.env.DEMO_CONTROL_SECRET
  if (!demoSecret) throw new Error('Set DEMO_CONTROL_SECRET to run the expiry demo')
  const expired = await fetch(new URL(`/v1/leases/${result.lease.lease_id}/expire`, url), {
    method: 'POST', headers: { Authorization: `Bearer ${demoSecret}` },
    redirect: 'error', signal: AbortSignal.timeout(20_000),
  })
  if (expired.status === 404) {
    throw new Error('Demo controls are disabled on this API or the demo secret was rejected')
  }
  if (!expired.ok) throw new Error(`Demo expiry returned HTTP ${expired.status}`)
  const expiredBody = JSON.stringify({ lease: result.lease.token, args, counter: 2,
    signature: prepared.subject.sign(invocation(2)) })
  await requireDenial(await toolCall(url, expiredBody), 410, 'LEASE_EXPIRED')
}

run().catch((error: unknown) => {
  console.error('Agent failed:', error instanceof Error ? error.message : 'Unexpected error')
  process.exitCode = 1
})
