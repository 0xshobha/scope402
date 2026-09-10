# Scope402 TypeScript SDK

TypeScript reference client for buying and using Scope402 capabilities on Hedera testnet.

The package keeps payment explicit: `prepareTessera()` retrieves and validates the exact
price and capability policy without moving HBAR. Only `approveTessera()` signs and sends
the payment. The returned root authority can paint within its purchased region or delegate
a strictly smaller resource, budget, and expiry to a different P-256 worker.

Read-only world discovery does not require a payment:

```ts
const worlds = await client.listTesseraWorlds()
const opal = await client.readTesseraWorld('opal-world')
console.log(worlds, opal.world.painted_pixels)
```

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
