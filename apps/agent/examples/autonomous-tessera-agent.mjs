import { Scope402Client, Scope402HttpError, ephemeralSubject, planTesseraMission } from '../dist/sdk.js'

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
  ...(process.env.HEDERA_PAYER_ACCOUNT_ID ? { payer: process.env.HEDERA_PAYER_ACCOUNT_ID } : {}),
  ...(process.env.HEDERA_MERCHANT_ACCOUNT_ID ? { merchant: process.env.HEDERA_MERCHANT_ACCOUNT_ID } : {}),
  ...(process.env.MAX_PAYMENT_TINYBARS ? { maxPaymentTinybars: process.env.MAX_PAYMENT_TINYBARS } : {}),
})

const selectedCanvasId = process.env.TESSERA_CANVAS_ID ?? 'main'
const worlds = await client.listTesseraWorlds()
const existingWorld = worlds.find((world) => world.canvas_id === selectedCanvasId)
let worldState
if (existingWorld) {
  worldState = await client.readTesseraWorld(selectedCanvasId)
  emit('WORLD_DISCOVERED', { world: existingWorld,
    painted_pixels: worldState.world.painted_pixels,
    available_territories: 16 - worldState.world.active_territories - worldState.world.reserved_territories })
} else {
  emit('NEW_WORLD_REQUESTED', { canvas_id: selectedCanvasId })
  worldState = { canvas_id: selectedCanvasId, width: 32, height: 32, regions: [], reservations: [] }
}

const plan = planTesseraMission(worldState)
emit('MISSION_PLANNED', {
  goal: plan.goal,
  territory: plan.slot,
  root_region: plan.rootRegion,
  worker_region: plan.workerRegion,
  principal_pixels: plan.principalPixels.length,
  worker_pixels: plan.workerPixels.length,
  required_calls: plan.requiredCalls,
  delegated_calls: plan.delegatedCalls,
  hbar_moved: false,
})

const missingPaymentConfig = [
  'HEDERA_PAYER_ACCOUNT_ID',
  'HEDERA_MERCHANT_ACCOUNT_ID',
  'MAX_PAYMENT_TINYBARS',
].filter((name) => !process.env[name])
if (missingPaymentConfig.length > 0) {
  emit('OBSERVATION_COMPLETE', {
    hbar_moved: false,
    message: 'World discovery needs no payment configuration. Configure all listed fields to request a quote.',
    missing: missingPaymentConfig,
  })
  process.exit(0)
}

const principal = ephemeralSubject()
const prepared = await client.prepareTessera({
  subject: principal,
  canvasId: selectedCanvasId,
  slot: plan.slot,
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
if (rootRegion.canvasId !== plan.rootRegion.canvasId || rootRegion.x !== plan.rootRegion.x ||
    rootRegion.y !== plan.rootRegion.y || rootRegion.width !== plan.rootRegion.width ||
    rootRegion.height !== plan.rootRegion.height) {
  throw new Error('Settled capability does not match the mission territory')
}
const child = await root.delegate({
  worker,
  resource: plan.workerRegion,
  maxCalls: plan.delegatedCalls,
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

try {
  await child.paint(plan.boundaryProbe)
  throw new Error('Worker boundary probe unexpectedly succeeded')
} catch (error) {
  if (!(error instanceof Scope402HttpError) || error.code !== 'OUT_OF_SCOPE') throw error
  emit('BOUNDARY_ENFORCED', {
    actor: 'worker',
    attempted_pixel: plan.boundaryProbe,
    status: error.status,
    code: error.code,
    remaining_calls: child.capability().remaining_calls,
    recovery: 'Principal retains authority for this pixel; worker continues only inside its region.',
  })
}

for (const target of plan.principalPixels) {
  const painted = await root.paint(target)
  emit('PRINCIPAL_PIXEL_PLACED', { pixel: painted.pixel, remaining_calls: painted.remaining_calls })
}
for (const target of plan.workerPixels) {
  const painted = await child.paint(target)
  emit('WORKER_PIXEL_PLACED', { pixel: painted.pixel, remaining_calls: painted.remaining_calls })
}

emit('MISSION_COMPLETE', {
  goal: plan.goal,
  payment_transaction: receipt.transaction,
  policy_hash: root.capability().policy_hash,
  root_lease_id: root.capability().lease_id,
  worker_lease_id: child.capability().lease_id,
  pixels_placed: plan.requiredCalls,
  denied_actions: [{ actor: 'worker', code: 'OUT_OF_SCOPE', pixel: plan.boundaryProbe }],
  root_remaining_calls: root.capability().remaining_calls,
  worker_remaining_calls: child.capability().remaining_calls,
})
