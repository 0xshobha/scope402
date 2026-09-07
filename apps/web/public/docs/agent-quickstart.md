# Use Scope402 from an agent

Scope402 sells limited access to an API. Tessera lets a principal buy an 8 × 8 canvas region with 12 calls and a five-minute lifetime, then delegate a smaller region and reserved budget to a different P-256 key. AuditLab provides the same purchase-and-permission pattern for a repository scan.

This guide uses the existing repository modules, not a published Scope402 SDK. It is for a Node.js agent running outside the browser. The examples below do not make a payment until you explicitly call `approvePlotPurchase`.

## 1. Read the service contract without spending

API origin: `https://scope402-auditlab.onrender.com`.
Website and documentation origin: `https://scope402.onrender.com`.

```bash
curl --fail --max-time 15 https://scope402-auditlab.onrender.com/health
curl --fail --max-time 15 https://scope402-auditlab.onrender.com/.well-known/scope402
curl --fail --max-time 15 https://scope402-auditlab.onrender.com/v1/canvas
```

These GET requests do not pay, reserve a plot, or grant authority. Discovery exposes routes at a known origin; it is not a directory listing. Health alone does not establish payment availability. The canvas can contain old pixels and expired regions.

Read the [API contract](https://scope402.onrender.com/docs/api-contract.md) and [Tessera OpenAPI](https://scope402.onrender.com/openapi.json) before implementing calls.

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
const { persistentSubject } = await import('./apps/agent/dist/subject.js');
const { preparePlotPurchase, approvePlotPurchase } = await import('./apps/agent/dist/tessera-purchase.js');
const policy = {
  auditLabUrl: new URL(process.env.AUDITLAB_URL),
  payer: process.env.HEDERA_PAYER_ACCOUNT_ID,
  merchant: process.env.HEDERA_MERCHANT_ACCOUNT_ID,
  maxPaymentTinybars: process.env.MAX_PAYMENT_TINYBARS,
};
const prepared = await preparePlotPurchase(policy, await persistentSubject());
console.log({ amount: prepared.terms.amount, payer: policy.payer,
  merchant: prepared.terms.payTo, network: prepared.terms.network,
  region: prepared.quote.region, policyHash: prepared.quote.policy_hash });
```

This creates or reuses a local P-256 key at `~/.config/scope402/subject.pem`, reads discovery, and obtains/validates a real unpaid 402 quote. It reserves one server-selected plot for up to five minutes. Prepare once and respect rate limits; do not repeatedly reserve plots to check health. Do not print the entire prepared object or export it into model context.

## 3. Approve only after inspecting the terms

If you intend to pay, include your own `HEDERA_PAYER_PRIVATE_KEY` in the private environment file **before starting the REPL**. The current client expects the ECDSA key format accepted by `PrivateKey.fromStringECDSA` from `@x402/hedera`. Never paste a key into a prompt or terminal command history.

In the same REPL, while the quote is valid, this explicitly signs and sends a real testnet payment:

```js
if (!process.env.HEDERA_PAYER_PRIVATE_KEY) throw new Error('Configure your own payer key before approving');
const purchase = await approvePlotPurchase({ ...policy,
  payerPrivateKey: process.env.HEDERA_PAYER_PRIVATE_KEY }, prepared);
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

Keep the returned lease in your agent runtime. Send signed calls to the discovered `place_pixel` route. To delegate, create a separate worker P-256 key and have the root subject sign the delegation terms in the [API contract](https://scope402.onrender.com/docs/api-contract.md). The worker signs its own invocations; it never needs the payer or root private key. The root reserves the worker's budget at delegation time.

Only one delegation level is supported. Coordinates use half-open rectangles. A new operation needs the next counter; delivery retries reuse the exact request and idempotency key. Do not use the hosted demo's internal action endpoints or expiry-control secret as an integration API.

For AuditLab, the existing CLI is documented in the [README](https://github.com/0xshobha/scope402#run-locally). That CLI proceeds to payment when run with a funded payer configuration; it is not a quote-only command.

## Current trust and compatibility boundary

The merchant verifies its lease signature server-side. No public JWKS or service-key distribution endpoint is provided today: external clients trust the configured HTTPS merchant and validate the returned policy/lineage. Do not claim offline independent issuer verification is already available through discovery.

The browser demonstration keeps keys and tokens server-side. Your independent agent necessarily holds its own keys and purchased capability. A model may request typed operations, but deterministic client code must validate and sign them. No general merchant registration, mainnet support, or automatic compatibility with arbitrary x402/MCP clients is promised.
