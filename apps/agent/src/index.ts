import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http'
import { createClientHederaSigner, inspectHederaTransaction, PrivateKey } from '@x402/hedera'
import { ExactHederaScheme } from '@x402/hedera/exact/client'
import { selectPayment } from './policy.js'
import { subjectPublicKey } from './subject.js'

async function run() {
  const payer = process.env.HEDERA_PAYER_ACCOUNT_ID
  const merchant = process.env.HEDERA_MERCHANT_ACCOUNT_ID
  const secret = process.env.HEDERA_PAYER_PRIVATE_KEY
  if (!payer || !merchant || !secret) throw new Error('Configure the payer account, payer private key, and merchant account')
  const repo = process.argv[2]
  if (!repo) throw new Error('Pass a public GitHub repository URL as the argument')
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
  const { required, terms } = selectPayment(decodePaymentRequiredHeader(header), url.href,
    merchant, payer, process.env.MAX_PAYMENT_TINYBARS ?? '100000')
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
  const retry = await fetch(url, {
    ...request,
    headers: { 'Content-Type': 'application/json', 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader({
      x402Version: 2, accepted: terms, resource: required.resource, payload: signed.payload,
    }) },
    signal: AbortSignal.timeout(60_000),
  })
  if (!retry.ok) {
    const failure: unknown = await retry.json().catch(() => null)
    const code = failure && typeof failure === 'object' && 'error' in failure ? String(failure.error) : 'UNKNOWN'
    throw new Error(`Paid retry returned HTTP ${retry.status}: ${code}`)
  }
  const receiptHeader = retry.headers.get('PAYMENT-RESPONSE')
  if (!receiptHeader) throw new Error('API returned success without PAYMENT-RESPONSE')
  const receipt = decodePaymentResponseHeader(receiptHeader)
  if (receipt.success !== true || !receipt.transaction || receipt.network !== 'hedera:testnet' || receipt.payer !== payer) {
    throw new Error('API returned an invalid settlement receipt')
  }
  console.log(`Settled transaction: ${receipt.transaction}`)
  console.log(JSON.stringify(await retry.json()))
}

run().catch((error: unknown) => {
  console.error('Agent failed:', error instanceof Error ? error.message : 'Unexpected error')
  process.exitCode = 1
})
