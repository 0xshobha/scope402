export function mirrorTransactionUrl(transaction: string) {
  const match = /^(0\.0\.\d+)@(\d+)\.(\d+)$/.exec(transaction)
  if (!match) return undefined
  return `https://testnet.mirrornode.hedera.com/api/v1/transactions/${match[1]}-${match[2]}-${match[3]}`
}
