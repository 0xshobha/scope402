# Scope402

**Payment is not authorization.**

Scope402 is an x402 service that accepts HBAR for useful work, then issues a short-lived capability describing what the payer may do afterward. The reference merchant, AuditLab, scans a public GitHub repository and grants the paying agent three signed calls to `finding_details` for five minutes.

Public API: [scope402-auditlab.onrender.com](https://scope402-auditlab.onrender.com/health)

Public web: [scope402.onrender.com](https://scope402.onrender.com)

## Why

An x402 settlement proves that money moved. It does not make a bearer credential safe to steal, stop a paid action from being replayed, or define a budget for later calls. Scope402 keeps those concerns separate:

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

There is intentionally one merchant tool: `finding_details`.

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

`pnpm test` includes PostgreSQL integration tests. It verifies a legitimate tool call, subject-key mismatch, invocation replay, server-side expiry, invalid finding behavior, and the concurrent same-counter race.

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
- Tessera currently exposes only the locally tested paid root-capability purchase boundary; pixel placement,
  delegation, the canvas UI, ENS, and WebMCP are not implemented or deployed yet

## AI assistance

AI tools assisted with research, implementation, and review. Every claimed payment, deployment, scan, and authorization result above was exercised against the named live or testnet boundary; local tests are described separately from public proof.
