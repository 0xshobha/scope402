import { serve } from '@hono/node-server'
import { createDemoAgentApp } from './demo-app.js'
import { createCapabilitySession } from './capability-demo.js'
import { DemoRunService, type DemoRunLimits } from './demo-runs.js'
import { approveScanPurchase, prepareScanPurchase, type PayerConfig } from './purchase.js'
import { ephemeralSubject } from './subject.js'

function required(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Set ${name}`)
  return value
}

function positiveInteger(name: string, fallback: string) {
  const value = process.env[name] ?? fallback
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${name} must be a positive integer`)
  return BigInt(value)
}

function boundedNumber(name: string, fallback: string, maximum: number) {
  const value = positiveInteger(name, fallback)
  if (value > BigInt(maximum)) throw new Error(`${name} must be at most ${maximum}`)
  return Number(value)
}

function config() {
  const auditLabUrl = new URL(process.env.AUDITLAB_URL ?? 'http://127.0.0.1:3000')
  if (auditLabUrl.protocol !== 'https:' &&
      !(auditLabUrl.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(auditLabUrl.hostname))) {
    throw new Error('AUDITLAB_URL must use HTTPS or localhost HTTP')
  }
  const payer = required('HEDERA_PAYER_ACCOUNT_ID')
  const merchant = required('HEDERA_MERCHANT_ACCOUNT_ID')
  if (!/^\d+\.\d+\.[1-9]\d*$/.test(payer) || !/^\d+\.\d+\.[1-9]\d*$/.test(merchant)) {
    throw new Error('Hosted demo payer and merchant must be Hedera account IDs')
  }
  if (payer === merchant) throw new Error('Hosted demo payer and AuditLab merchant must be different')
  const payerConfig: PayerConfig = {
    auditLabUrl, payer, merchant,
    maxPaymentTinybars: process.env.MAX_PAYMENT_TINYBARS ?? '150000',
    payerPrivateKey: required('HEDERA_PAYER_PRIVATE_KEY'),
  }
  const limits: DemoRunLimits = {
    runTtlMs: boundedNumber('DEMO_RUN_TTL_SECONDS', '240', 600) * 1_000,
    perIpRunsPerHour: boundedNumber('DEMO_MAX_RUNS_PER_IP_HOUR', '3', 100),
    globalRunsPerHour: boundedNumber('DEMO_MAX_GLOBAL_RUNS_HOUR', '50', 2_000),
    globalApprovalsPerHour: boundedNumber('DEMO_MAX_GLOBAL_APPROVALS_HOUR', '20', 1_000),
    maxHourlySpendTinybars: positiveInteger('DEMO_MAX_HOURLY_SPEND_TINYBARS', '3000000'),
    minimumBalanceTinybars: positiveInteger('DEMO_MIN_BALANCE_TINYBARS', '1000000'),
  }
  const allowedOrigins = new Set((process.env.DEMO_ALLOWED_ORIGINS ??
    'https://scope402.onrender.com,http://127.0.0.1:4173,http://localhost:4173')
    .split(',').map((value) => value.trim()).filter(Boolean))
  return { payerConfig, limits, allowedOrigins, demoControlSecret: required('DEMO_CONTROL_SECRET') }
}

async function payerBalanceTinybars(accountId: string) {
  const response = await fetch(`https://testnet.mirrornode.hedera.com/api/v1/accounts/${accountId}`, {
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`Hedera Mirror Node returned HTTP ${response.status}`)
  const body = await response.json() as { balance?: { balance?: unknown } }
  const balance = body.balance?.balance
  if (typeof balance !== 'number' || !Number.isSafeInteger(balance) || balance < 0) {
    throw new Error('Hedera Mirror Node returned an invalid payer balance')
  }
  return BigInt(balance)
}

const { payerConfig, limits, allowedOrigins, demoControlSecret } = config()
const service = new DemoRunService({
  prepare: (repoUrl) => prepareScanPurchase(payerConfig, repoUrl, ephemeralSubject()),
  approve: (prepared) => approveScanPurchase(payerConfig, prepared),
  payerBalanceTinybars: () => payerBalanceTinybars(payerConfig.payer),
  createCapabilitySession: (prepared, result) =>
    createCapabilitySession(prepared, result, demoControlSecret),
  logError: (message) => console.error(`Demo approval failed: ${message}`),
}, limits)
const app = createDemoAgentApp(service, allowedOrigins)
const port = Number(process.env.PORT ?? 3001)

serve({ fetch: app.fetch, hostname: '0.0.0.0', port }, (info) => {
  console.log(`Scope402 Demo Agent listening on :${info.port}`)
})
