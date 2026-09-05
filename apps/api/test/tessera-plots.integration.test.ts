import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { test } from 'node:test'
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http'
import { PaymentRequiredV2Schema } from '@x402/core/schemas'
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types'
import { createClientHederaSigner, inspectHederaTransaction, PrivateKey } from '@x402/hedera'
import { ExactHederaScheme } from '@x402/hedera/exact/client'
import { app } from '../src/app.js'
import { clearHederaSupportCache } from '../src/blocky.js'
import { closeDatabase, database, initializeDatabase } from '../src/db.js'
import { fulfillPaidPlot } from '../src/merchants/tessera/jobs.js'
import { beginPlotPayment, createPlotQuote, loadPlotQuote,
  type PlotPricing } from '../src/merchants/tessera/quotes.js'
import { settleBegunPayment } from '../src/settlement.js'

const merchant = '0.0.2002'
const payer = '0.0.1001'
const feePayer = '0.0.3003'
const endpoint = 'http://127.0.0.1:3000/v1/plots'
const audience = 'http://127.0.0.1:3000/v1/tools'
const pricing: PlotPricing = {
  base_tinybars: '50000', per_call_tinybars: '500', calls: 12,
  total_tinybars: '56000',
}
const requirements: PaymentRequirements = {
  scheme: 'exact', network: 'hedera:testnet', asset: '0.0.0', amount: '56000',
  payTo: merchant, maxTimeoutSeconds: 120, extra: { feePayer },
}
const service = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const subject = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const subjectPubkey = subject.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')

async function cleanTessera() {
  await database().query(
    `DELETE FROM plot_jobs
     WHERE quote_id IN (SELECT quote_id FROM payment_quotes WHERE merchant_id = 'tessera')`,
  )
  await database().query(`DELETE FROM tool_leases WHERE merchant_id = 'tessera'`)
  await database().query(
    `DELETE FROM payment_redemptions WHERE quote_id IN
       (SELECT quote_id FROM payment_quotes WHERE merchant_id = 'tessera')`)
  await database().query(
    `UPDATE tessera_slots SET quote_id = NULL, status = 'available',
       reservation_expires_at = NULL, transaction_id = NULL`)
  await database().query(`DELETE FROM payment_quotes WHERE merchant_id = 'tessera'`)
}

function receipt(transaction: string) {
  return { success: true as const, network: 'hedera:testnet' as const, transaction, payer }
}

async function settledQuote() {
  const quote = await createPlotQuote(subjectPubkey, endpoint, requirements, pricing, audience)
  const signer = createClientHederaSigner(payer, PrivateKey.generateED25519())
  const signed = await new ExactHederaScheme(signer).createPaymentPayload(2, requirements)
  const transactionId = inspectHederaTransaction(signed.payload.transaction as string).transactionId
  await database().query(
    `INSERT INTO payment_redemptions (transaction_id, quote_id, status, payer, receipt)
     VALUES ($1, $2, 'settled', $3, $4)`,
    [transactionId, quote.quoteId, payer, JSON.stringify(receipt(transactionId))],
  )
  return { quote, transactionId, signed }
}

test('reserves Tessera plots and issues one payment-bound root capability', async (t) => {
  const previousKey = process.env.TOOL_LEASE_PRIVATE_KEY
  const previousKeyPath = process.env.TOOL_LEASE_PRIVATE_KEY_PATH
  process.env.TOOL_LEASE_PRIVATE_KEY = service.privateKey
    .export({ format: 'pem', type: 'pkcs8' }).toString()
  await initializeDatabase()
  await cleanTessera()
  t.after(async () => {
    await cleanTessera()
    if (previousKey === undefined) delete process.env.TOOL_LEASE_PRIVATE_KEY
    else process.env.TOOL_LEASE_PRIVATE_KEY = previousKey
    if (previousKeyPath === undefined) delete process.env.TOOL_LEASE_PRIVATE_KEY_PATH
    else process.env.TOOL_LEASE_PRIVATE_KEY_PATH = previousKeyPath
    await closeDatabase()
  })

  await t.test('database initialization is idempotent and keeps exactly sixteen slots', async () => {
    await initializeDatabase()
    assert.equal((await database().query(
      `SELECT count(*)::int AS count FROM tessera_slots WHERE canvas_id = 'main'`)).rows[0].count, 16)
  })

  await t.test('concurrent quotes reserve different fixed regions and no paid state', async () => {
    const [first, second] = await Promise.all([
      createPlotQuote(subjectPubkey, endpoint, requirements, pricing, audience),
      createPlotQuote(subjectPubkey, endpoint, requirements, pricing, audience),
    ])
    assert.notDeepEqual(first.resource, second.resource)
    assert.equal((await database().query(
      `SELECT count(*)::int AS count FROM tessera_slots WHERE status = 'pending'`)).rows[0].count, 2)
    assert.equal((await database().query(
      `SELECT count(*)::int AS count FROM payment_redemptions`)).rows[0].count, 0)
    assert.equal((await database().query(
      `SELECT count(*)::int AS count FROM tool_leases WHERE merchant_id = 'tessera'`)).rows[0].count, 0)
    await assert.rejects(loadPlotQuote(first.quoteId, 'main', 'another-subject', false),
      /missing, expired, or no longer owns/)
    await cleanTessera()
  })

  await t.test('expired unpaid reservation is reassigned and cannot be resurrected', async () => {
    const stale = await createPlotQuote(subjectPubkey, endpoint, requirements, pricing, audience)
    await database().query(
      `UPDATE payment_quotes SET expires_at = now() - interval '1 minute' WHERE quote_id = $1`,
      [stale.quoteId])
    await database().query(
      `UPDATE tessera_slots SET reservation_expires_at = now() - interval '1 minute'
       WHERE quote_id = $1`, [stale.quoteId])
    const replacement = await createPlotQuote(subjectPubkey, endpoint, requirements, pricing, audience)
    assert.deepEqual(replacement.resource, stale.resource)
    await assert.rejects(loadPlotQuote(stale.quoteId, 'main', subjectPubkey, true),
      /no longer owns/)
    await cleanTessera()
  })

  await t.test('payment protection cannot revive an expired or reassigned reservation', async () => {
    const stale = await createPlotQuote(subjectPubkey, endpoint, requirements, pricing, audience)
    await database().query(
      `UPDATE payment_quotes SET expires_at = now() - interval '1 minute' WHERE quote_id = $1`,
      [stale.quoteId])
    await database().query(
      `UPDATE tessera_slots SET reservation_expires_at = now() - interval '1 minute'
       WHERE quote_id = $1`, [stale.quoteId])
    await assert.rejects(beginPlotPayment('0.0.1001@1788614000.000000001', stale.quoteId),
      /expired or lost/)
    const replacement = await createPlotQuote(subjectPubkey, endpoint, requirements, pricing, audience)
    assert.deepEqual(replacement.resource, stale.resource)
    await assert.rejects(beginPlotPayment('0.0.1001@1788614000.000000002', stale.quoteId),
      /expired or lost/)
    await cleanTessera()
  })

  await t.test('an expired reservation cannot be revived while its quote is still valid', async () => {
    const stale = await createPlotQuote(subjectPubkey, endpoint, requirements, pricing, audience)
    await database().query(
      `UPDATE tessera_slots SET reservation_expires_at = now() - interval '1 minute'
       WHERE quote_id = $1`, [stale.quoteId])
    await assert.rejects(loadPlotQuote(stale.quoteId, 'main', subjectPubkey),
      /missing, expired, or no longer owns/)
    await assert.rejects(beginPlotPayment('0.0.1001@1788614000.000000003', stale.quoteId),
      /expired or lost/)
    await cleanTessera()
  })

  await t.test('reservation protection and redemption handoff are atomic', async () => {
    const purchased = await createPlotQuote(subjectPubkey, endpoint, requirements, pricing, audience)
    const transactionId = '0.0.1001@1788614000.000000004'
    await beginPlotPayment(transactionId, purchased.quoteId)
    assert.deepEqual((await database().query(
      `SELECT quote_id, status FROM payment_redemptions WHERE transaction_id = $1`,
      [transactionId])).rows[0], { quote_id: purchased.quoteId, status: 'verifying' })
    await database().query(
      `UPDATE tessera_slots SET reservation_expires_at = now() - interval '1 minute'
       WHERE quote_id = $1`, [purchased.quoteId])
    const next = await createPlotQuote(subjectPubkey, endpoint, requirements, pricing, audience)
    assert.notDeepEqual(next.resource, purchased.resource)
    assert.deepEqual((await loadPlotQuote(
      purchased.quoteId, 'main', subjectPubkey, true)).resource, purchased.resource)
    await cleanTessera()
  })

  await t.test('a stale verification cannot settle after its reservation is reclaimed', async () => {
    const stale = await createPlotQuote(subjectPubkey, endpoint, requirements, pricing, audience)
    const signer = createClientHederaSigner(payer, PrivateKey.generateED25519())
    const signed = await new ExactHederaScheme(signer).createPaymentPayload(2, requirements)
    const payload: PaymentPayload = {
      x402Version: 2, accepted: requirements,
      resource: { url: stale.resourceUrl, description: 'Tessera root', mimeType: 'application/json' },
      payload: signed.payload, extensions: stale.extensions,
    }
    const transactionId = inspectHederaTransaction(
      signed.payload.transaction as string).transactionId
    await beginPlotPayment(transactionId, stale.quoteId)
    await database().query(
      `UPDATE payment_redemptions SET updated_at = clock_timestamp() - interval '4 minutes'
       WHERE transaction_id = $1`, [transactionId])
    await database().query(
      `UPDATE tessera_slots SET reservation_expires_at = clock_timestamp() - interval '1 minute'
       WHERE quote_id = $1`, [stale.quoteId])
    const replacement = await createPlotQuote(subjectPubkey, endpoint, requirements, pricing, audience)
    assert.deepEqual(replacement.resource, stale.resource)
    assert.equal((await database().query(
      `SELECT count(*)::int AS count FROM payment_redemptions WHERE transaction_id = $1`,
      [transactionId])).rows[0].count, 0)

    const originalFetch = globalThis.fetch
    let settleCalls = 0
    globalThis.fetch = (async (url) => {
      if (String(url).endsWith('/verify')) return Response.json({ isValid: true, payer })
      if (String(url).endsWith('/settle')) {
        settleCalls += 1
        return Response.json({ success: true, network: 'hedera:testnet', payer, transaction: transactionId })
      }
      throw new Error(`Unexpected fetch ${String(url)}`)
    }) as typeof fetch
    try {
      await assert.rejects(settleBegunPayment(payload, requirements),
        (error: unknown) => (error as { code?: string }).code === 'PAYMENT_STATE_ERROR')
      assert.equal(settleCalls, 0)
    } finally {
      globalThis.fetch = originalFetch
    }
    await cleanTessera()
  })

  await t.test('a settled redemption protects an expired reservation during recovery', async () => {
    const purchased = await settledQuote()
    await database().query(
      `UPDATE payment_quotes SET expires_at = now() - interval '1 minute' WHERE quote_id = $1`,
      [purchased.quote.quoteId])
    await database().query(
      `UPDATE tessera_slots SET reservation_expires_at = now() - interval '1 minute'
       WHERE quote_id = $1`, [purchased.quote.quoteId])
    const next = await createPlotQuote(subjectPubkey, endpoint, requirements, pricing, audience)
    assert.notDeepEqual(next.resource, purchased.quote.resource)
    assert.deepEqual((await loadPlotQuote(
      purchased.quote.quoteId, 'main', subjectPubkey, true)).resource, purchased.quote.resource)
    await cleanTessera()
  })

  await t.test('concurrent fulfillment persists one lease and cached retries return it', async () => {
    const purchased = await settledQuote()
    const input = { transactionId: purchased.transactionId, quoteId: purchased.quote.quoteId,
      subjectPubkey, requirements, receipt: receipt(purchased.transactionId),
      policy: purchased.quote.extensions.scope402.info }
    const outcomes = await Promise.allSettled([fulfillPaidPlot(input), fulfillPaidPlot(input)])
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1)
    const completed = outcomes.find((outcome) => outcome.status === 'fulfilled') as PromiseFulfilledResult<
      Awaited<ReturnType<typeof fulfillPaidPlot>>>
    const cached = await fulfillPaidPlot(input)
    assert.equal(cached.lease.token, completed.value.lease.token)
    assert.equal(cached.lease.policy_hash, purchased.quote.extensions.scope402.info.policyHash)
    assert.deepEqual(cached.lease.resource, purchased.quote.resource)
    assert.equal(cached.lease.offer_id, purchased.quote.quoteId)
    assert.equal(cached.lease.hedera_tx_id, purchased.transactionId)
    assert.equal(cached.lease.max_calls, 12)
    const persisted = await database().query(
      `SELECT payment_quote_id, merchant_id, resource, format_version
       FROM tool_leases WHERE hedera_tx_id = $1`, [purchased.transactionId])
    assert.deepEqual(persisted.rows[0], { payment_quote_id: purchased.quote.quoteId,
      merchant_id: 'tessera', resource: purchased.quote.resource, format_version: 2 })
    assert.equal((await database().query(
      `SELECT count(*)::int AS count FROM tool_leases WHERE hedera_tx_id = $1`,
      [purchased.transactionId])).rows[0].count, 1)
    await cleanTessera()
  })

  await t.test('post-settlement signing failure recovers without losing the region', async () => {
    const purchased = await settledQuote()
    const input = { transactionId: purchased.transactionId, quoteId: purchased.quote.quoteId,
      subjectPubkey, requirements, receipt: receipt(purchased.transactionId),
      policy: purchased.quote.extensions.scope402.info }
    delete process.env.TOOL_LEASE_PRIVATE_KEY
    delete process.env.TOOL_LEASE_PRIVATE_KEY_PATH
    await assert.rejects(fulfillPaidPlot(input),
      (error: unknown) => (error as { code?: string }).code === 'PLOT_RETRYABLE')
    assert.equal((await database().query(
      `SELECT status FROM tessera_slots WHERE quote_id = $1`,
      [purchased.quote.quoteId])).rows[0].status, 'pending')
    assert.equal((await database().query(
      `SELECT count(*)::int AS count FROM tool_leases WHERE hedera_tx_id = $1`,
      [purchased.transactionId])).rows[0].count, 0)
    process.env.TOOL_LEASE_PRIVATE_KEY = service.privateKey
      .export({ format: 'pem', type: 'pkcs8' }).toString()
    assert.equal((await fulfillPaidPlot(input)).status, 'complete')
    assert.equal((await database().query(
      `SELECT status FROM tessera_slots WHERE quote_id = $1`,
      [purchased.quote.quoteId])).rows[0].status, 'allocated')
    await cleanTessera()
  })
})

test('POST /v1/plots settles once and returns the exact persisted root policy', async (t) => {
  const previous = {
    merchant: process.env.HEDERA_MERCHANT_ACCOUNT_ID,
    origin: process.env.AUDITLAB_URL,
    key: process.env.TOOL_LEASE_PRIVATE_KEY,
  }
  const originalFetch = globalThis.fetch
  let verifyCalls = 0
  let settleCalls = 0
  process.env.HEDERA_MERCHANT_ACCOUNT_ID = merchant
  process.env.AUDITLAB_URL = 'http://127.0.0.1:3000'
  process.env.TOOL_LEASE_PRIVATE_KEY = service.privateKey
    .export({ format: 'pem', type: 'pkcs8' }).toString()
  clearHederaSupportCache()
  globalThis.fetch = (async (url, init) => {
    const target = String(url)
    if (target.endsWith('/supported')) return Response.json({ kinds: [{
      scheme: 'exact', network: 'hedera:testnet', x402Version: 2, extra: { feePayer },
    }] })
    if (target.endsWith('/verify')) {
      verifyCalls += 1
      return Response.json({ isValid: true, payer })
    }
    if (target.endsWith('/settle')) {
      settleCalls += 1
      const body = JSON.parse(String(init?.body)) as {
        paymentPayload: { payload: { transaction: string } }
      }
      const transaction = inspectHederaTransaction(
        body.paymentPayload.payload.transaction).transactionId
      return Response.json({ success: true, network: 'hedera:testnet', payer, transaction })
    }
    throw new Error(`Unexpected fetch ${target}`)
  }) as typeof fetch
  await initializeDatabase()
  await cleanTessera()
  t.after(async () => {
    await cleanTessera()
    globalThis.fetch = originalFetch
    clearHederaSupportCache()
    if (previous.merchant === undefined) delete process.env.HEDERA_MERCHANT_ACCOUNT_ID
    else process.env.HEDERA_MERCHANT_ACCOUNT_ID = previous.merchant
    if (previous.origin === undefined) delete process.env.AUDITLAB_URL
    else process.env.AUDITLAB_URL = previous.origin
    if (previous.key === undefined) delete process.env.TOOL_LEASE_PRIVATE_KEY
    else process.env.TOOL_LEASE_PRIVATE_KEY = previous.key
    await closeDatabase()
  })

  const body = JSON.stringify({ canvas_id: 'main', subject_pubkey: subjectPubkey })
  const unpaid = await app.request('/v1/plots', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.191' }, body })
  assert.equal(unpaid.status, 402)
  const required = decodePaymentRequiredHeader(unpaid.headers.get('PAYMENT-REQUIRED')!)
  assert.equal(PaymentRequiredV2Schema.safeParse(required).success, true)
  const quoteBody = await unpaid.json() as { quote: { region: unknown; pricing: PlotPricing } }
  assert.deepEqual(quoteBody.quote.pricing, pricing)
  assert.equal((required.extensions as { scope402: { info: { policyHash: string } } })
    .scope402.info.policyHash.startsWith('sha256:'), true)

  const terms = required.accepts[0]!
  const signer = createClientHederaSigner(payer, PrivateKey.generateED25519())
  const signed = await new ExactHederaScheme(signer).createPaymentPayload(2, terms)
  const payload: PaymentPayload = { x402Version: 2, accepted: terms,
    resource: required.resource, payload: signed.payload, extensions: required.extensions }
  const paidRequest = (value: PaymentPayload) => app.request(new URL(required.resource.url).pathname +
    new URL(required.resource.url).search, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(value),
    }, body })
  const paid = await paidRequest(payload)
  assert.equal(paid.status, 200)
  assert.equal(paid.headers.has('PAYMENT-RESPONSE'), true)
  const result = await paid.json() as { status: string; region: unknown; lease: {
    token: string; policy_hash: string; resource: unknown; max_calls: number; offer_id: string } }
  const quotedInfo = (required.extensions as { scope402: { info: {
    policyHash: string; resource: unknown } } }).scope402.info
  assert.equal(result.status, 'complete')
  assert.deepEqual(result.region, quoteBody.quote.region)
  assert.deepEqual(result.lease.resource, quotedInfo.resource)
  assert.equal(result.lease.policy_hash, quotedInfo.policyHash)
  assert.equal(result.lease.max_calls, 12)
  assert.equal(verifyCalls, 1)
  assert.equal(settleCalls, 1)

  await database().query(
    `UPDATE payment_quotes SET expires_at = now() - interval '1 minute'
     WHERE quote_id = $1`, [result.lease.offer_id])
  const cached = await paidRequest(payload)
  assert.equal(cached.status, 200)
  assert.equal((await cached.json() as { lease: { token: string } }).lease.token, result.lease.token)
  assert.equal(verifyCalls, 1)
  assert.equal(settleCalls, 1)

  const changed = structuredClone(payload)
  const info = (changed.extensions as { scope402: { info: { maxCalls: number } } }).scope402.info
  info.maxCalls = 13
  assert.equal((await paidRequest(changed)).status, 400)

  const secondUnpaid = await app.request('/v1/plots', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.192' }, body })
  assert.equal(secondUnpaid.status, 402)
  const secondRequired = decodePaymentRequiredHeader(secondUnpaid.headers.get('PAYMENT-REQUIRED')!)
  const crossQuote = await app.request(new URL(secondRequired.resource.url).pathname +
    new URL(secondRequired.resource.url).search, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(payload),
    }, body })
  assert.equal(crossQuote.status, 400)
  assert.equal(verifyCalls, 1)
  assert.equal(settleCalls, 1)
})
