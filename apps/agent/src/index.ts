import { createHash } from 'node:crypto'
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http'
import { createClientHederaSigner, inspectHederaTransaction, PrivateKey } from '@x402/hedera'
import { ExactHederaScheme } from '@x402/hedera/exact/client'
import { canonicalJson } from './canonical.js'
import { selectPayment } from './policy.js'
import { attackerSubject, signInvocation, subjectPublicKey } from './subject.js'

type ScanResult = {
  findings?: Array<{ id?: string }>
  lease?: { token?: string; lease_id?: string }
}

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
  const url = new URL('/v1/scans', process.env.AUDITLAB_URL ?? 'http://127.0.0.1:3000')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) {
    throw new Error('Use HTTPS, or HTTP on localhost only')
  }
  const body = JSON.stringify({ repo_url: repo, subject_pubkey: await subjectPublicKey() })
  const request = { method: 'POST', body, redirect: 'error' as const }
  const response = await fetch(url, {
    ...request, headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20_000),
  })
  if (response.status !== 402) throw new Error(`Expected 402; API returned HTTP ${response.status}`)
  const header = response.headers.get('PAYMENT-REQUIRED')
  if (!header) throw new Error('402 response has no PAYMENT-REQUIRED header')
  const { required, paymentUrl, terms } = selectPayment(decodePaymentRequiredHeader(header), url.href,
    merchant, payer, process.env.MAX_PAYMENT_TINYBARS ?? '150000')
  console.log(`402 received: ${terms.amount} tinybars from ${payer} to ${merchant}`)
  const signer = createClientHederaSigner(payer, PrivateKey.fromStringECDSA(secret), { network: 'hedera:testnet' })
  const signed = await new ExactHederaScheme(signer).createPaymentPayload(2, terms)
  const transaction = signed.payload.transaction
  if (typeof transaction !== 'string') throw new Error('SDK returned no signed transfer')
  const inspected = inspectHederaTransaction(transaction)
  if (inspected.hbarTransfers.find((entry) => entry.accountId === payer)?.amount !== `-${terms.amount}` ||
      inspected.hbarTransfers.find((entry) => entry.accountId === merchant)?.amount !== terms.amount) {
    throw new Error('Signed transfer does not match the approved payment')
  }
  console.log('Hedera transfer signed; retrying with PAYMENT-SIGNATURE')
  const paymentSignature = encodePaymentSignatureHeader({
    x402Version: 2, accepted: terms, resource: required.resource, payload: signed.payload,
  })
  let retry: Response | undefined
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    retry = await fetch(paymentUrl, {
      ...request,
      headers: { 'Content-Type': 'application/json', 'PAYMENT-SIGNATURE': paymentSignature },
      signal: AbortSignal.timeout(60_000),
    })
    if (retry.ok) break
    const failure: unknown = await retry.json().catch(() => null)
    const code = failure && typeof failure === 'object' && 'error' in failure ? String(failure.error) : 'UNKNOWN'
    if (!['SCAN_RETRYABLE', 'SCAN_IN_PROGRESS'].includes(code) || attempt === 3) {
      throw new Error(`Paid retry returned HTTP ${retry.status}: ${code}`)
    }
    console.log(`Paid scan is recoverable (${code}); retrying the same payment`)
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  if (!retry?.ok) throw new Error('Paid scan recovery did not complete')
  const receiptHeader = retry.headers.get('PAYMENT-RESPONSE')
  if (!receiptHeader) throw new Error('API returned success without PAYMENT-RESPONSE')
  const receipt = decodePaymentResponseHeader(receiptHeader)
  if (receipt.success !== true || !receipt.transaction || receipt.network !== 'hedera:testnet' || receipt.payer !== payer) {
    throw new Error('API returned an invalid settlement receipt')
  }
  console.log(`Settled transaction: ${receipt.transaction}`)
  const result = await retry.json() as ScanResult
  console.log(JSON.stringify(result))
  if (!result.lease?.token || !result.lease.lease_id) throw new Error('Paid scan returned no ToolLease')
  const findingId = result.findings?.find((finding) => typeof finding.id === 'string')?.id
  if (!findingId) {
    console.log('[SCAN] COMPLETE — no findings')
    return
  }
  const args = { finding_id: findingId }
  const invocation = (counter: number) => ({
    lease_id: result.lease!.lease_id!, tool_id: 'finding_details', counter,
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
    signature: await signInvocation(invocation(1)) })
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
    signature: await signInvocation(invocation(2)) })
  await requireDenial(await toolCall(url, expiredBody), 410, 'LEASE_EXPIRED')
}

run().catch((error: unknown) => {
  console.error('Agent failed:', error instanceof Error ? error.message : 'Unexpected error')
  process.exitCode = 1
})
