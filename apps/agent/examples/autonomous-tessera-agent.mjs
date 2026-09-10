import { Scope402Client, ephemeralSubject } from '../dist/sdk.js'

const required = (name) => {
  const value = process.env[name]
  if (!value) throw new Error(`Set ${name}`)
  return value
}

const emit = (event, details = {}) => console.log(JSON.stringify({
  at: new Date().toISOString(), event, ...details,
}, null, 2))

const client = new Scope402Client({
  auditLabUrl: new URL(process.env.AUDITLAB_URL ?? 'https://scope402-auditlab.onrender.com'),
  payer: required('HEDERA_PAYER_ACCOUNT_ID'),
  merchant: required('HEDERA_MERCHANT_ACCOUNT_ID'),
  maxPaymentTinybars: process.env.MAX_PAYMENT_TINYBARS ?? '100000',
})

const selectedCanvasId = process.env.TESSERA_CANVAS_ID ?? 'main'
const worlds = await client.listTesseraWorlds()
const existingWorld = worlds.find((world) => world.canvas_id === selectedCanvasId)
if (existingWorld) {
  const state = await client.readTesseraWorld(selectedCanvasId)
  emit('WORLD_DISCOVERED', { world: existingWorld,
    painted_pixels: state.world.painted_pixels,
    available_territories: 16 - state.world.active_territories - state.world.reserved_territories })
} else {
  emit('NEW_WORLD_REQUESTED', { canvas_id: selectedCanvasId })
}

const principal = ephemeralSubject()
const prepared = await client.prepareTessera({
  subject: principal,
  canvasId: selectedCanvasId,
  slot: process.env.TESSERA_SLOT === undefined ? undefined : Number(process.env.TESSERA_SLOT),
})

emit('PAYMENT_APPROVAL_REQUIRED', {
  amount_tinybars: prepared.terms.amount,
  merchant: prepared.terms.payTo,
  resource: prepared.quote.region,
  policy_hash: prepared.quote.policy_hash,
  decision: 'No payment occurs until SCOPE402_APPROVE_PAYMENT=yes',
})

if (process.env.SCOPE402_APPROVE_PAYMENT !== 'yes') {
  emit('PAYMENT_NOT_SENT', { reason: 'approval_required', hbar_moved: false })
  process.exit(0)
}

const { receipt, authority: root } = await client.approveTessera(
  prepared,
  required('HEDERA_PAYER_PRIVATE_KEY'),
)
const worker = ephemeralSubject()
const rootRegion = root.capability().resource
const workerRegion = {
  ...rootRegion,
  x: rootRegion.x + 2,
  y: rootRegion.y + 2,
  width: 4,
  height: 4,
}
const child = await root.delegate({
  worker,
  resource: workerRegion,
  maxCalls: 1,
  expiresAt: Math.min(root.capability().exp, Math.floor(Date.now() / 1_000) + 120),
})
emit('CAPABILITY_DELEGATED', {
  payment_transaction: receipt.transaction,
  root_lease_id: root.capability().lease_id,
  worker_lease_id: child.capability().lease_id,
  root_region: root.capability().resource,
  worker_region: child.capability().resource,
  worker_calls: child.capability().max_calls,
})
const painted = await child.paint({ x: workerRegion.x, y: workerRegion.y, color: '#7C4DFF' })

emit('WORKER_PIXEL_PLACED', {
  transaction: receipt.transaction,
  root: root.capability(),
  worker: child.capability(),
  pixel: painted.pixel,
})
