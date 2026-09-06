import type { PaymentPayload, PaymentRequirements, SettleResponse } from '@x402/core/types'
import { inspectHederaTransaction } from '@x402/hedera'
import { PaymentError } from './payment-error.js'
import { abandonVerification, ambiguousRedemption, beginRedemption, markReconciledSettlement,
  markSettlement, markSettlementAttempted } from './payments.js'

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

export function paymentTransactionId(payload: PaymentPayload) {
  try {
    if (typeof payload.payload.transaction !== 'string') throw new Error('No transaction')
    const transaction = inspectHederaTransaction(payload.payload.transaction).transactionId
    hashscanUrl(transaction)
    return transaction
  } catch {
    throw new PaymentError('PAYMENT_INVALID', 'Invalid Hedera transfer payload')
  }
}

function mirrorTransactionId(transaction: string) {
  const parts = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/.exec(transaction)
  if (!parts) throw new PaymentError('FACILITATOR_ERROR', 'Invalid Hedera transaction ID')
  return `${parts[1]}-${parts[2]}-${parts[3]}`
}

function transferAmount(transfers: unknown, account: string): bigint | undefined {
  if (!Array.isArray(transfers)) return undefined
  let total = 0n
  let found = false
  for (const transfer of transfers) {
    if (typeof transfer !== 'object' || transfer === null || Array.isArray(transfer)) return undefined
    const value = transfer as Record<string, unknown>
    if (value.account !== account) continue
    if (typeof value.amount !== 'number' || !Number.isSafeInteger(value.amount)) return undefined
    total += BigInt(value.amount)
    found = true
  }
  return found ? total : undefined
}

export function mirrorSettlementReceipt(value: unknown, payer: string, transaction: string,
  requirements: PaymentRequirements): SettleResponse | undefined {
  if (requirements.scheme !== 'exact' || requirements.network !== 'hedera:testnet' ||
      requirements.asset !== '0.0.0') return undefined
  const body = record(value)
  if (!Array.isArray(body.transactions)) return undefined
  const expectedId = mirrorTransactionId(transaction)
  const amount = BigInt(requirements.amount)
  for (const candidate of body.transactions) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) continue
    const tx = candidate as Record<string, unknown>
    if (tx.transaction_id !== expectedId || tx.result !== 'SUCCESS' || tx.name !== 'CRYPTOTRANSFER') continue
    const payerAmount = transferAmount(tx.transfers, payer)
    const merchantAmount = transferAmount(tx.transfers, requirements.payTo)
    if (payerAmount === -amount && merchantAmount === amount) {
      return { success: true, network: 'hedera:testnet', transaction, payer }
    }
  }
  return undefined
}

async function reconcileSettlement(payer: string, transaction: string,
  requirements: PaymentRequirements): Promise<SettleResponse | undefined> {
  const id = mirrorTransactionId(transaction)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`https://testnet.mirrornode.hedera.com/api/v1/transactions/${id}`, {
        redirect: 'error', signal: AbortSignal.timeout(8_000),
      })
      if (response.ok) {
        const receipt = mirrorSettlementReceipt(await response.json(), payer, transaction, requirements)
        if (receipt) return receipt
      }
    } catch {
      // A failed reconciliation must remain settlement_unknown; it must never permit a second payment.
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)))
  }
  return undefined
}

export async function reconcileAmbiguousRedemption(transaction: string, quoteId: string) {
  const ambiguous = await ambiguousRedemption(transaction, quoteId)
  if (!ambiguous) return undefined
  const receipt = await reconcileSettlement(ambiguous.payer, transaction, ambiguous.requirements)
  if (!receipt) {
    throw new PaymentError('SETTLEMENT_UNKNOWN',
      `Settlement was attempted for ${transaction}; Hedera reconciliation is still pending`)
  }
  await markReconciledSettlement(transaction, receipt)
  return receipt
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
  const transaction = paymentTransactionId(payload)
  await beginRedemption(transaction, quoteId)
  return completeSettlement(transaction, payload, requirements)
}

export async function settleBegunPayment(payload: PaymentPayload, requirements: PaymentRequirements) {
  return completeSettlement(paymentTransactionId(payload), payload, requirements)
}

async function completeSettlement(transaction: string, payload: PaymentPayload,
  requirements: PaymentRequirements) {
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
    const reconciled = await reconcileSettlement(payer, transaction, requirements)
    if (reconciled) {
      await markSettlement(transaction, 'settled', reconciled)
      return reconciled
    }
    await markSettlement(transaction, 'settlement_unknown', { error: error instanceof Error ? error.message : 'Unknown error' })
    throw new PaymentError('SETTLEMENT_UNKNOWN', `Settlement was attempted for ${transaction}; check Hedera before starting another payment`)
  }
}
