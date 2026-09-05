import { decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http'
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types'
import { createClientHederaSigner, inspectHederaTransaction, PrivateKey } from '@x402/hedera'
import { ExactHederaScheme } from '@x402/hedera/exact/client'

export type ExactHederaPayer = {
  payer: string
  merchant: string
  payerPrivateKey: string
}

export type PreparedExactPayment = {
  paymentUrl: string
  requestBody: string
  required: PaymentRequired
  terms: PaymentRequirements
  paymentSignature?: string
}

export class ExactPaymentDeliveryError extends Error {}

export async function executeExactHederaPayment<T>(config: ExactHederaPayer,
  prepared: PreparedExactPayment, retryCodes: ReadonlySet<string>, parseResult: (value: unknown) => T,
  request: typeof fetch = fetch,
  pause: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds))): Promise<{
    receipt: ReturnType<typeof decodePaymentResponseHeader>
    result: T
  }> {
  if (!prepared.paymentSignature) {
    const signer = createClientHederaSigner(config.payer,
      PrivateKey.fromStringECDSA(config.payerPrivateKey), { network: 'hedera:testnet' })
    const signed = await new ExactHederaScheme(signer).createPaymentPayload(2, prepared.terms)
    const transaction = signed.payload.transaction
    if (typeof transaction !== 'string') throw new Error('SDK returned no signed transfer')
    const inspected = inspectHederaTransaction(transaction)
    if (inspected.hbarTransfers.find((entry) => entry.accountId === config.payer)?.amount !==
        `-${prepared.terms.amount}` ||
        inspected.hbarTransfers.find((entry) => entry.accountId === config.merchant)?.amount !==
        prepared.terms.amount) {
      throw new Error('Signed transfer does not match the approved payment')
    }
    prepared.paymentSignature = encodePaymentSignatureHeader({
      x402Version: 2,
      accepted: prepared.terms,
      resource: prepared.required.resource,
      payload: signed.payload,
      extensions: prepared.required.extensions ?? undefined,
    })
  }
  const paymentSignature = prepared.paymentSignature
  let response: Response | undefined
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      response = await request(prepared.paymentUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'PAYMENT-SIGNATURE': paymentSignature },
        body: prepared.requestBody,
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
      })
    } catch (error) {
      if (attempt === 3) throw new ExactPaymentDeliveryError(
        `Paid request remained unreachable after ${attempt} attempts`, { cause: error })
      await pause(2_000)
      continue
    }
    if (response.ok) break
    const failure = await response.json().catch(() => null) as Record<string, unknown> | null
    const code = String(failure?.error ?? 'UNKNOWN')
    if (retryCodes.has(code) && attempt === 3) {
      throw new ExactPaymentDeliveryError(`Paid purchase remains recoverable: ${code}`)
    }
    if (!retryCodes.has(code)) {
      throw new Error(`Paid retry returned HTTP ${response.status}: ${code}`)
    }
    await pause(2_000)
  }
  if (!response?.ok) throw new Error('Paid purchase recovery did not complete')
  const receiptHeader = response.headers.get('PAYMENT-RESPONSE')
  if (!receiptHeader) throw new Error('API returned success without PAYMENT-RESPONSE')
  const receipt = decodePaymentResponseHeader(receiptHeader)
  if (receipt.success !== true || !receipt.transaction || receipt.network !== 'hedera:testnet' ||
      receipt.payer !== config.payer) throw new Error('API returned an invalid settlement receipt')
  return { receipt, result: parseResult(await response.json()) }
}
