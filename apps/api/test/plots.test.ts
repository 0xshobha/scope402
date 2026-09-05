import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { test } from 'node:test'
import { meterPlot, parsePlotRequest, plotPricingConfig, plotResourceUrl } from '../src/plots.js'

const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const subject = publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')

test('accepts only the fixed Tessera canvas and a P-256 subject', () => {
  assert.deepEqual(parsePlotRequest({ canvas_id: 'main', subject_pubkey: subject }),
    { canvas_id: 'main', subject_pubkey: subject })
  for (const request of [
    {}, { canvas_id: 'other', subject_pubkey: subject },
    { canvas_id: 'main', subject_pubkey: 'bad' },
    { canvas_id: 'main', subject_pubkey: subject, amount: '1' },
  ]) assert.throws(() => parsePlotRequest(request))
})

test('prices the fixed root call budget deterministically', (t) => {
  const previousBase = process.env.PLOT_BASE_TINYBARS
  const previousUnit = process.env.PLOT_PER_CALL_TINYBARS
  t.after(() => {
    if (previousBase === undefined) delete process.env.PLOT_BASE_TINYBARS
    else process.env.PLOT_BASE_TINYBARS = previousBase
    if (previousUnit === undefined) delete process.env.PLOT_PER_CALL_TINYBARS
    else process.env.PLOT_PER_CALL_TINYBARS = previousUnit
  })
  process.env.PLOT_BASE_TINYBARS = '50000'
  process.env.PLOT_PER_CALL_TINYBARS = '500'
  assert.deepEqual(meterPlot(), {
    base_tinybars: '50000', per_call_tinybars: '500', calls: 12,
    total_tinybars: '56000',
  })
  process.env.PLOT_PER_CALL_TINYBARS = '100000000'
  assert.throws(plotPricingConfig, /must not exceed/)
})

test('uses the configured public origin for plot quotes', (t) => {
  const previous = process.env.AUDITLAB_URL
  process.env.AUDITLAB_URL = 'https://scope402-auditlab.onrender.com'
  t.after(() => {
    if (previous === undefined) delete process.env.AUDITLAB_URL
    else process.env.AUDITLAB_URL = previous
  })
  assert.equal(plotResourceUrl('http://internal/v1/plots'),
    'https://scope402-auditlab.onrender.com/v1/plots')
})
