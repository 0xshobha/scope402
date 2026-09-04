import type { PaymentPayload, PaymentRequirements, SettleResponse } from '@x402/core/types'
import { inspectHederaTransaction } from '@x402/hedera'
import { PaymentError } from './payment-error.js'
import { abandonVerification, beginRedemption, markSettlement, markSettlementAttempted } from './payments.js'

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PaymentError('FACILITATOR_ERROR', 'Blocky402 returned an invalid response')
  }
  return value as Record<string, unknown>
}

export function verifiedPayer(value: unknown): string {
  const body = record(value)
  if (body.isValid !== true) {
    throw new PaymentError('PAYMENT_INVALID', String(body.invalidReason ?? 'Blocky402 verification failed'))
  }
  if (typeof body.payer !== 'string' || !/^\d+\.\d+\.[1-9]\d*$/.test(body.payer)) {
    throw new PaymentError('FACILITATOR_ERROR', 'Verification did not identify a payer')
  }
  return body.payer
}

export function hashscanUrl(transaction: string): string {
  const parts = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/.exec(transaction)
  if (!parts) throw new PaymentError('FACILITATOR_ERROR', 'Invalid Hedera transaction ID')
  return `https://hashscan.io/testnet/transaction/${parts[1]}-${parts[2]}-${parts[3]}`
}

export function settlementReceipt(value: unknown, payer: string, transaction: string): SettleResponse {
  const body = record(value)
  if (body.success !== true) {
    throw new PaymentError('SETTLEMENT_FAILED', String(body.errorReason ?? 'Blocky402 settlement failed'))
  }
  if (body.network !== 'hedera:testnet' || body.payer !== payer || body.transaction !== transaction) {
    throw new PaymentError('SETTLEMENT_UNKNOWN', 'Settlement receipt does not match the submitted payment')
  }
  hashscanUrl(transaction)
  return { success: true, network: 'hedera:testnet', transaction, payer }
}

async function facilitator(path: 'verify' | 'settle', payload: PaymentPayload, requirements: PaymentRequirements) {
  const response = await fetch(`https://api.testnet.blocky402.com/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: requirements }),
    signal: AbortSignal.timeout(path === 'settle' ? 40_000 : 15_000), redirect: 'error',
  })
  if (!response.ok) {
    throw new PaymentError('FACILITATOR_ERROR', `Blocky402 /${path} returned HTTP ${response.status}`)
  }
  return response.json() as Promise<unknown>
}

export async function settlePayment(quoteId: string, payload: PaymentPayload, requirements: PaymentRequirements) {
  let transaction: string
  try {
    if (typeof payload.payload.transaction !== 'string') throw new Error('No transaction')
    transaction = inspectHederaTransaction(payload.payload.transaction).transactionId
    hashscanUrl(transaction)
  } catch {
    throw new PaymentError('PAYMENT_INVALID', 'Invalid Hedera transfer payload')
  }
  await beginRedemption(transaction, quoteId)
  let payer: string
  try {
    payer = verifiedPayer(await facilitator('verify', payload, requirements))
    if (payer === requirements.payTo) throw new PaymentError('PAYMENT_INVALID', 'Merchant cannot pay itself')
  } catch (error) {
    await abandonVerification(transaction)
    throw error
  }
  await markSettlementAttempted(transaction, payer)
  try {
    const raw = await facilitator('settle', payload, requirements)
    const receipt = settlementReceipt(raw, payer, transaction)
    await markSettlement(transaction, 'settled', receipt)
    return receipt
  } catch (error) {
    if (error instanceof PaymentError && error.code === 'SETTLEMENT_FAILED') {
      await markSettlement(transaction, 'settlement_failed', { error: error.message })
      throw error
    }
    await markSettlement(transaction, 'settlement_unknown', { error: error instanceof Error ? error.message : 'Unknown error' })
    throw new PaymentError('SETTLEMENT_UNKNOWN', `Settlement was attempted for ${transaction}; check Hedera before starting another payment`)
  }
}
