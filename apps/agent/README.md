# Scope402 TypeScript SDK

TypeScript reference client for buying and using Scope402 capabilities on Hedera testnet.

The package keeps payment explicit: `prepareTessera()` retrieves and validates the exact
price and capability policy without moving HBAR. Only `approveTessera()` signs and sends
the payment. The returned root authority can paint within its purchased region or delegate
a strictly smaller resource, budget, and expiry to a different P-256 worker.

Read-only world discovery and live observation do not require a payment:

```ts
const client = new Scope402Client({
  auditLabUrl: new URL('https://scope402-auditlab.onrender.com'),
})
const worlds = await client.listTesseraWorlds()
const opal = await client.readTesseraWorld('opal-world')
console.log(worlds, opal.world.painted_pixels)

// Follow validated public snapshots without a payer key.
for await (const state of client.watchTesseraWorld('opal-world', AbortSignal.timeout(30_000))) {
  console.log(state.world.total_placements, state.recent_activity[0])
}
```

`watchTesseraWorld()` uses the public server-sent event stream, ignores heartbeats, and validates every
complete snapshot before yielding it to an agent. Reconnect after transport failure or use
`readTesseraWorld()` as a polling fallback. Neither read path reserves territory or moves HBAR.

Payer, merchant, and spending-limit configuration is required only when preparing paid work.
The client rejects a purchase locally before making a request if any of those policy fields is absent.

The repository-local CLI exposes the same validated read-only path:

```bash
corepack pnpm --filter @scope402/agent build
node apps/agent/dist/cli.js worlds
node apps/agent/dist/cli.js world main
node apps/agent/dist/cli.js watch main
```

The first two commands return machine-readable JSON. `watch` emits one compact validated snapshot per
line until interrupted, which is convenient for another process or agent. None prepares a quote or moves
HBAR. Use `--api` to inspect another compatible HTTPS deployment or a local development server.

## Plan a multi-agent mission

`planTesseraMission()` is a deterministic, read-only planner for the included Signal Spark mission. It inspects
claimed and reserved territories, chooses the first open `8 × 8` region, and returns the exact principal pixels,
worker pixels, contained worker region, call requirements, and an intentional worker boundary probe. Planning
does not reserve land or move HBAR:

```ts
import { Scope402Client, planTesseraMission } from '@scope402/agent'

const reader = new Scope402Client({
  auditLabUrl: new URL('https://scope402-auditlab.onrender.com'),
})
const world = await reader.readTesseraWorld('main')
const plan = planTesseraMission(world)

console.log(plan.goal, plan.slot, plan.requiredCalls, plan.delegatedCalls)
```

The complete repository example discovers the world, emits `MISSION_PLANNED`, stops for explicit payment
approval, then uses the returned root authority to delegate four calls, recover from a real `OUT_OF_SCOPE`
denial, and place all nine mission pixels:

```bash
node --env-file=/absolute/path/to/agent.env apps/agent/examples/autonomous-tessera-agent.mjs
```

Set `SCOPE402_APPROVE_PAYMENT=yes` only when you intend to send the displayed Hedera testnet payment. The
example never treats planning or quote preparation as settlement.

```ts
import { Scope402Client, ephemeralSubject } from '@scope402/agent'

const client = new Scope402Client({
  auditLabUrl: new URL('https://scope402-auditlab.onrender.com'),
  payer: process.env.HEDERA_PAYER_ACCOUNT_ID!,
  merchant: process.env.HEDERA_MERCHANT_ACCOUNT_ID!,
  maxPaymentTinybars: '100000',
})

const principal = ephemeralSubject()
const quote = await client.prepareTessera({
  subject: principal,
  canvasId: 'main',
})

// Show quote.terms.amount and quote.quote.policy_hash to the user or policy engine here.
const { receipt, authority: root } = await client.approveTessera(
  quote,
  process.env.HEDERA_PAYER_PRIVATE_KEY!,
)

const worker = ephemeralSubject()
const region = root.capability().resource
const child = await root.delegate({
  worker,
  resource: { ...region, x: region.x + 2, y: region.y + 2, width: 4, height: 4 },
  maxCalls: 1,
  expiresAt: Math.min(root.capability().exp, Math.floor(Date.now() / 1000) + 120),
})

await child.paint({
  x: child.capability().resource.x,
  y: child.capability().resource.y,
  color: '#7C4DFF',
})

console.log(receipt.transaction)
```

This is a local reference SDK in the monorepo, not a published npm package. Its operation
and counter recovery state is process-local: after uncertain delivery, retry the exact same
operation ID and arguments before starting another action. The package also contains the
hosted reference-agent implementation used by the browser demo.
