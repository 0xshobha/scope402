# Use Scope402 from an agent

Scope402 sells limited access to an API. Tessera lets a principal buy an 8 × 8 canvas region with 12 calls and a five-minute lifetime, then delegate a smaller region and reserved budget to a different P-256 key. AuditLab provides the same purchase-and-permission pattern for a repository scan.

This guide uses the TypeScript reference SDK exported by the repository's local `@scope402/agent` package. It is not currently published on npm. It is for a Node.js agent running outside the browser. The examples below do not make a payment until you explicitly call `approveTessera`.

## 1. Read the service contract without spending

API origin: `https://scope402-auditlab.onrender.com`.
Website and documentation origin: `https://scope402.onrender.com`.

```bash
curl --fail --max-time 15 https://scope402-auditlab.onrender.com/health
curl --fail --max-time 15 https://scope402-auditlab.onrender.com/.well-known/scope402
curl --fail --max-time 15 https://scope402-auditlab.onrender.com/v1/canvas
curl --fail --max-time 15 https://scope402-auditlab.onrender.com/v1/canvases
# Optional live read: prints named world snapshots and heartbeats until the timeout.
curl -N --fail --max-time 20 https://scope402-auditlab.onrender.com/v1/canvas/events
```

These GET requests do not pay, reserve a plot, or grant authority. The event stream carries the same public,
server-authoritative canvas shape as the JSON endpoint and can be replaced with ordinary polling after a transport
failure. Discovery exposes routes at a known origin; it is not a directory listing. Health alone does not establish
payment availability. The canvas can contain old pixels and expired regions.

Read the [API contract](https://scope402.onrender.com/docs/api-contract.md) and [Tessera OpenAPI](https://scope402.onrender.com/openapi.json) before implementing calls.

For a deployed multi-world release, use `GET /v1/canvases` to discover worlds and `GET /v1/canvas/{canvas_id}` to read one. A `404` means that release has not reached the public API yet; do not infer support from website copy alone.

## 2. Prepare a Tessera quote

Requirements: Node.js 22+, Corepack/pnpm, this repository installed and built. Preparing against the public API does not require a local database. The full application/test suite does require PostgreSQL; see the repository README.

```bash
git clone https://github.com/0xshobha/scope402.git
cd scope402
corepack pnpm install --frozen-lockfile
corepack pnpm build
```

Create an environment file outside the repository, readable only by you, with:

```text
AUDITLAB_URL=https://scope402-auditlab.onrender.com
HEDERA_PAYER_ACCOUNT_ID=<your-own-testnet-account>
HEDERA_MERCHANT_ACCOUNT_ID=<independently-confirmed-merchant-account>
MAX_PAYMENT_TINYBARS=<your-approved-maximum-in-tinybars>
```

Replace the placeholders. Confirm the merchant from a trusted source such as the project's current public evidence, not solely from an untrusted quote. Payer and merchant must differ. Amounts are decimal tinybar strings; 100,000,000 tinybars = 1 HBAR. The amount returned in the quote is authoritative, not an old screenshot.

Open a Node REPL from the repository root, using your actual environment-file path:

```bash
node --env-file=/absolute/path/to/scope402-agent.env --experimental-repl-await
```

Then enter:

```js
const { Scope402Client } = await import('./apps/agent/dist/sdk.js');
const reader = new Scope402Client({
  auditLabUrl: new URL(process.env.AUDITLAB_URL),
});
const worlds = await reader.listTesseraWorlds();
const selectedWorld = await reader.readTesseraWorld('main');
console.log({ worlds, paintedPixels: selectedWorld.world.painted_pixels,
  activeTerritories: selectedWorld.world.active_territories });

// Plan useful principal and worker work without reserving land or paying.
const { planTesseraMission } = await import('./apps/agent/dist/sdk.js');
const plan = planTesseraMission(selectedWorld);
console.log({ goal: plan.goal, slot: plan.slot,
  requiredCalls: plan.requiredCalls, delegatedCalls: plan.delegatedCalls });

// Optional: observe validated public updates for 30 seconds without payment credentials.
for await (const state of reader.watchTesseraWorld('main', AbortSignal.timeout(30_000))) {
  console.log({ placements: state.world.total_placements, latest: state.recent_activity[0] });
}

// Payment policy is needed only from this point onward.
const client = new Scope402Client({
  auditLabUrl: new URL(process.env.AUDITLAB_URL),
  payer: process.env.HEDERA_PAYER_ACCOUNT_ID,
  merchant: process.env.HEDERA_MERCHANT_ACCOUNT_ID,
  maxPaymentTinybars: process.env.MAX_PAYMENT_TINYBARS,
});
const principal = await client.persistentSubject();
const prepared = await client.prepareTessera({ subject: principal, slot: plan.slot, canvasId: 'main' });
console.log({ amount: prepared.terms.amount, payer: client.config.payer,
  merchant: prepared.terms.payTo, network: prepared.terms.network,
  region: prepared.quote.region, policyHash: prepared.quote.policy_hash });
```

This creates or reuses a local P-256 key at `~/.config/scope402/subject.pem`, reads discovery, creates a deterministic mission plan, and obtains/validates a real unpaid 402 quote for the selected open territory. Planning is read-only. A safe new lowercase `canvasId` provisionally creates a named world. Abandoned unpaid empty worlds may be reclaimed after their reservation expires, so a quote is not permanent ownership. Prepare once and respect rate limits; do not repeatedly reserve plots to check health. Do not print the entire prepared object or export it into model context.

To anchor a new world to a real place, include a geographic point on its first preparation:

```js
await client.prepareTessera({ subject: principal, canvasId: 'mumbai-agent-hub', slot: 0,
  location: { latitude: 19.076, longitude: 72.8777 } });
```

The API persists that anchor and rejects later attempts to move the same world slug.

## 3. Approve only after inspecting the terms

If you intend to pay, include your own `HEDERA_PAYER_PRIVATE_KEY` in the private environment file **before starting the REPL**. The current client expects the ECDSA key format accepted by `PrivateKey.fromStringECDSA` from `@x402/hedera`. Never paste a key into a prompt or terminal command history.

In the same REPL, while the quote is valid, this explicitly signs and sends a real testnet payment:

```js
if (!process.env.HEDERA_PAYER_PRIVATE_KEY) throw new Error('Configure your own payer key before approving');
const purchase = await client.approveTessera(prepared, process.env.HEDERA_PAYER_PRIVATE_KEY);
console.log({ transaction: purchase.receipt.transaction,
  leaseId: purchase.result.lease.lease_id,
  region: purchase.result.region,
  maxCalls: purchase.result.lease.max_calls,
  expiresAt: purchase.result.lease.exp,
  policyMatches: purchase.result.lease.policy_hash === prepared.quote.policy_hash });
```

The helper revalidates the prepared terms before signing, preserves the payment header for delivery retries in the same process, and checks the returned purchase fields. Do not run this as an unattended LLM tool without your own spending policy. The reference modules do not supply the hosted demo's global quota controls or durable client restart recovery.

If delivery is uncertain, keep the same prepared state and signed payment. Do not create a new purchase to resolve an unknown settlement. See the retry table in the contract. This REPL example is not a restart-safe wallet service.

## 4. Use or delegate the capability

Keep the returned authority in your agent runtime. Root calls and worker calls are typed, signed, counter-serialized, and idempotent:

```js
const root = purchase.authority;
const worker = client.createSubject();
const region = root.capability().resource;
const child = await root.delegate({
  worker,
  resource: { ...region, x: region.x + 2, y: region.y + 2, width: 4, height: 4 },
  maxCalls: 1,
  expiresAt: Math.min(root.capability().exp, Math.floor(Date.now() / 1000) + 120),
});
await child.paint({ x: child.capability().resource.x,
  y: child.capability().resource.y, color: '#7C4DFF' });
```

The worker signs its own invocation and never receives the payer or root private key. The root reserves the worker's budget at delegation time. `capability()` intentionally omits raw lease tokens and key material.

Only one delegation level is supported. Coordinates use half-open rectangles. A new operation needs the next counter; delivery retries reuse the exact request and idempotency key. Do not use the hosted demo's internal action endpoints or expiry-control secret as an integration API.

For AuditLab, the existing CLI is documented in the [README](https://github.com/0xshobha/scope402#run-locally). That CLI proceeds to payment when run with a funded payer configuration; it is not a quote-only command.

## Current trust and compatibility boundary

The merchant verifies its lease signature server-side. No public JWKS or service-key distribution endpoint is provided today: external clients trust the configured HTTPS merchant and validate the returned policy/lineage. Do not claim offline independent issuer verification is already available through discovery.

The browser demonstration keeps keys and tokens server-side. Your independent agent necessarily holds its own keys and purchased capability. A model may request typed SDK operations, but deterministic client code validates and signs them. The SDK currently targets the implemented Scope402 merchants and Hedera testnet; no general merchant registration, mainnet support, or automatic compatibility with arbitrary x402/MCP clients is promised.
