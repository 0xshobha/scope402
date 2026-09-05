import type { PaymentRequirements } from '@x402/core/types'
import { hashscanUrl } from './settlement.js'

export function settledPaymentDetails(requirements: PaymentRequirements,
  receipt: { payer?: string; transaction: string }) {
  return {
    payer: receipt.payer,
    merchant: requirements.payTo,
    amount_tinybars: requirements.amount,
    transaction: receipt.transaction,
    hashscan_url: hashscanUrl(receipt.transaction),
  }
}
