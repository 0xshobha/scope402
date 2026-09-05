# Scope402

**Payment is not authorization.**

Scope402 is a payment-and-permission layer for AI agents. An agent can pay HBAR for useful work without
receiving unlimited access afterward. Each purchase defines who may act, what they may do, how many times,
and for how long; Scope402 represents that limited permission as a signed capability.

The reference merchant, AuditLab, scans a public GitHub repository and grants the declared agent three signed
calls to `finding_details` for five minutes.

Tessera reuses the same authorization kernel for a spatial resource: a principal purchases an `8 × 8`
paint capability, then delegates a strictly narrower, conserved call budget to a different P-256 worker.
Its public browser flow can prepare and recover a real payment quote; a public Tessera settlement is not yet
claimed as evidence.

Public API: [scope402-auditlab.onrender.com](https://scope402-auditlab.onrender.com/health)

Public web: [scope402.onrender.com](https://scope402.onrender.com)

## Why

An x402 settlement proves that money moved. It does not decide what the buyer may do afterward. Scope402
connects the purchase to limited permission while keeping payment and authorization separate:

```text
Scope402 Agent                 AuditLab                     Hedera
      |                           |                            |
      | POST /v1/scans           |                            |
      |-------------------------->|                            |
      | 402 PAYMENT-REQUIRED     |                            |
      |<--------------------------|                            |
      |                           |                            |
      | PAYMENT-SIGNATURE        | verify + settle via        |
      |-------------------------->| Blocky402 ---------------->|
      |                           |                            |
      |              scan repository at an exact commit       |
      |              issue P-256 subject-bound ToolLease      |
      |<-------------------------------------------------------|
      |                           |                            |
      | signed finding_details   |                            |
      |-------------------------->| atomic counter + budget    |
      | finding                  | enforcement in PostgreSQL  |
      |<--------------------------|                            |
```

The browser is not trusted with either the Hedera payer key or the subject private key. The payer is a separate Node.js process. The merchant never pays itself.

## Use cases

Scope402 is useful when one payment should unlock several narrowly authorized follow-up actions instead of
charging for every call or exposing a broad bearer credential:

- **Paid developer tools:** purchase a repository scan, then use the resulting capability for finding details,
  report export, or remediation actions within its declared tool, call, resource, and time limits.
- **Browser and agent tools:** let an agent purchase a short working session for specific actions such as search,
  booking, submission, or editing without placing payment or capability keys in the browser.
- **AI APIs:** sell a bounded analysis package or temporary access to selected models and tools instead of an
  open-ended subscription or permanent API key.
- **Multi-agent workflows:** allow a principal agent to delegate a smaller resource scope, shorter lifetime, and
  conserved call budget to a worker without sharing the payment wallet or root private key.
- **Cloud and DevOps operations:** authorize narrowly scoped actions such as reading one environment's logs,
  restarting one service, or performing one deployment for a limited period.
- **Data and research access:** grant temporary access to specific datasets, query types, and usage budgets after
  payment while keeping later requests independently authorized.

## Implemented

- x402 v2 HTTP flow using `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, and `PAYMENT-RESPONSE`
- Blocky402 discovery, verification, and Hedera testnet settlement
- native HBAR payment with distinct payer and merchant accounts
- durable quote and transaction replay protection
- resumable paid scan fulfillment without a second settlement
- public GitHub commit resolution and one bounded hygiene check
- compact ES256 ToolLease bound to the subject key declared before payment
- five-minute expiry and three-call budget
- RFC 8785/JCS argument hashing
- atomic counter and budget consumption in PostgreSQL
- explicit wrong-key, replay, expiry, and concurrent-counter tests
- responsive browser homepage backed by the live health and discovery endpoints
- guarded hosted testnet agent with prepare-before-pay approval, rate limits, spend ceiling, and balance floor
- browser demo for a real metered quote, explicit approval, settlement, scan result, ToolLease, allowed call,
  wrong-key denial, replay denial, and expiry denial
- x402 v2 `scope402` extension that binds the declared subject, exact resource revision, tool allowlist,
  call budget, and lease lifetime before the payer signs
- merchant-independent policy, lease, invocation, replay, expiry, budget, and resource-authorization kernel
- locally tested Tessera `POST /v1/plots`, server-authoritative canvas, and atomic `place_pixel` execution
- parent-signed Tessera attenuation to a distinct worker key with strict rectangle containment, immutable
  payment lineage, separate delegation replay counters, and conserved parent/child budgets
- guarded Tessera browser orchestration with prepare-before-pay approval, refresh recovery, and fixed
  server-generated delegation and attack actions

AuditLab exposes `finding_details`; Tessera exposes `place_pixel`. AuditLab has a public payment-to-denial
proof. Tessera has a public, judge-runnable prepare flow; its first public paid run remains an explicit evidence
gate.

## Public proof

A public-origin run against `sindresorhus/is` completed payment, scanning, lease issuance, an authorized
follow-up, wrong-key denial, byte-identical replay denial, and server-side expiry denial.

- Transaction: `0.0.7162784@1788595940.223982333`
- [HashScan](https://hashscan.io/testnet/transaction/0.0.7162784-1788595940-223982333)
- Payer: `0.0.10374937`
- Merchant: `0.0.8258555`
- Amount: `55500` tinybars (`0.000555 HBAR`)
- Scanned commit: `7821031c66cdeb7256a0feb2d506535f9e84fcaf`
- Lease audience: `https://scope402-auditlab.onrender.com/v1/tools`

The Hedera Mirror Node reports `SUCCESS` and the corresponding 55,500 tinybar payer debit and merchant
credit. The public hosted-agent path returned `200 FINDING_DETAILS_ALLOWED`, `403 SUBJECT_KEY_MISMATCH`,
`403 REPLAY_DETECTED`, and `410 LEASE_EXPIRED`.

## Run locally

Requirements: Node.js 22+, pnpm through Corepack, and PostgreSQL.

```bash
corepack pnpm install --frozen-lockfile
cp apps/api/.env.example apps/api/.env
corepack pnpm build
corepack pnpm start
```

API environment:

```text
DATABASE_URL=
HEDERA_MERCHANT_ACCOUNT_ID=
SCAN_BASE_PRICE_TINYBARS=50000
SCAN_PER_FILE_TINYBARS=500
SCAN_FILE_CAP=100
AUDITLAB_URL=http://127.0.0.1:3000
TOOL_LEASE_PRIVATE_KEY_PATH=/absolute/path/to/p256-private-key.pem
GITHUB_TOKEN=
```

Generate the merchant's lease-signing key outside the repository:

```bash
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out ~/.config/scope402/lease-signing.pem
chmod 600 ~/.config/scope402/lease-signing.pem
```

The agent additionally requires its own funded Hedera testnet payer account and private key. Keep those values in an environment file outside the repository:

```text
AUDITLAB_URL=http://127.0.0.1:3000
HEDERA_PAYER_ACCOUNT_ID=
HEDERA_PAYER_PRIVATE_KEY=
HEDERA_MERCHANT_ACCOUNT_ID=
MAX_PAYMENT_TINYBARS=150000
```

Run the paid client:

```bash
node --env-file=/path/to/agent.env apps/agent/dist/index.js https://github.com/expressjs/express
```

Run the browser app locally:

```bash
corepack pnpm --filter @scope402/web dev
```

## Verify

```bash
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

`pnpm test` includes PostgreSQL integration tests. It verifies AuditLab payment recovery and ToolLease
enforcement plus Tessera slot reservation, atomic pixel mutation, resource denial, parent-signed delegation,
immutable lineage, root expiry, budget conservation, and concurrent invocation/delegation races.

## Current boundaries

- Hedera **testnet**, not mainnet
- public GitHub repositories only
- one deterministic repository check and one follow-up tool
- quotes bind an exact GitHub commit and meter bounded root-file workload
- API and browser app are public; `/demo` can request a quote and ask a dedicated hosted testnet agent to purchase it
- the hosted demo payer is separate from the merchant and policy-limited; the browser never receives payment or capability keys
- completed paid retries return the original scan and ToolLease instead of granting fresh authority
- browser actions are fixed requests to the hosted agent; keys, lease tokens, signatures, and demo-control secrets
  remain outside the browser
- no HCS anchoring, Agent Kit plugin, or additional sponsor integration yet
- Tessera's paid-root, atomic pixel, one-level delegation, hosted-agent orchestration, and browser UI are
  implemented and deployed; no public Tessera HBAR transaction, ENS, or WebMCP proof is claimed yet

## AI assistance

AI tools assisted with research, implementation, and review. Every claimed payment, deployment, scan, and authorization result above was exercised against the named live or testnet boundary; local tests are described separately from public proof.
