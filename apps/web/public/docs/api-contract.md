# Scope402 HTTP and signing contract

Contract snapshot: 11 September 2026. x402 v2; Scope402 extension `info.version = 1`; discovery `version = 1`. These are different version fields. This document describes the implemented reference API, not a platform-wide SDK guarantee.

Base URL: `https://scope402-auditlab.onrender.com`. Use HTTPS for remote clients. Documentation and [Tessera OpenAPI](https://scope402.onrender.com/openapi.json) live on the separate website origin. The OpenAPI file covers Tessera and public metadata, not hosted-agent administration or AuditLab schemas.

## Routes

| Method and path | Input / output |
|---|---|
| `GET /health` | `{ "ok": true, "service": "auditlab" }`; process health only |
| `GET /.well-known/scope402` | Known-origin resource and tool metadata |
| `GET /v1/canvas` | Canvas dimensions, palette, persisted pixels and root regions |
| `GET /v1/canvas/events` | Default-world snapshots as named `world` server-sent events |
| `GET /v1/canvas/{canvas_id}` | One named world's server-authoritative state, activity and contributor ranking |
| `GET /v1/canvas/{canvas_id}/events` | Named-world snapshots as named `world` server-sent events |
| `GET /v1/canvases` | Public world catalogue; does not reserve or pay |
| `POST /v1/plots` | `{ "canvas_id": "<safe-world-slug>", "subject_pubkey": "<SPKI key>", "slot"?: 0..15 }`; no other properties |
| `POST /v1/scans` | `{ "repo_url": "https://github.com/owner/repository", "subject_pubkey": "<SPKI key>" }` |
| `POST /v1/tools/place_pixel` | Signed invocation envelope below |
| `POST /v1/tools/finding_details` | Same invocation envelope, `args = { "finding_id": "<returned finding ID>" }` |
| `POST /v1/leases/{lease_id}/delegations` | `{ "lease": "<root lease JWS>", "delegation": "<parent-signed JWS>" }`; Tessera only |

All POST bodies are JSON. Purchase requests are limited to 4,096 bytes; invocation/delegation requests to 32,768 bytes. A size-limit response can be HTTP 413 plain text, not the JSON error envelope. Public read routes permit cross-origin GETs. Direct paid/signed routes are for server-side clients; no arbitrary-origin browser CORS support is promised.

The SSE routes emit the complete `Canvas` JSON object as a named `world` event on connection and whenever the
authoritative snapshot changes. They send a heartbeat during quiet periods and advertise a five-second reconnect.
Clients should retain the last valid snapshot and recover through the corresponding JSON GET route if streaming is
unavailable. The stream contains public world state only—never payment headers, lease tokens, private keys, or signed
invocations. It is a bounded reference transport, not a WebSocket-scale or on-chain state guarantee.

`subject_pubkey` is a base64url-encoded DER SPKI P-256 public key (Node curve `prime256v1`), **not** a PEM string, JWK, address, fingerprint, or private key. Payer identity and subject identity are separate.

## Prepare and pay

Without `PAYMENT-SIGNATURE`, a valid purchase request returns HTTP 402 with a `PAYMENT-REQUIRED` header and JSON body. The header is encoded by `@x402/core/http`; use its decoder. The body contains the x402 fields plus merchant quote details:

```text
x402Version: 2
error: descriptive missing-payment message
resource: { url: quoted URL including ?quote_id=..., description, mimeType }
accepts: [{ scheme, network, asset, amount, payTo, maxTimeoutSeconds, extra }]
extensions: { scope402: { info, schema } }
quote: Tessera { canvas_id, region, pricing }
       AuditLab { repository, commit_sha, pricing }
```

Current payment terms use `exact`, `hedera:testnet`, and native HBAR asset `0.0.0`. Prices are decimal strings in tinybars. Read facilitator fee-payer information from its current `/supported` response. Never choose a destination or spending cap solely because remote metadata asks for it.

The caller may select one of sixteen fixed Tessera `8 × 8` slots, or omit `slot` and let the merchant select the first available one. Callers cannot supply an arbitrary root rectangle. `canvas_id` is `main` or a safe 3–32 character lowercase slug; the first quote provisionally creates a named world. Empty worlds created only by abandoned unpaid quotes may be reclaimed after the five-minute reservation expires. A paid, painted, allocated, protected-settlement, or active-reservation world is not reclaimed by this cleanup path. Default Tessera pricing is 50,000 + 500 × 12 = 56,000 tinybars, configurable server-side. Root budget is 12 calls. AuditLab binds an exact commit and prices bounded root entries. Quote validity/reservation is five minutes; the 300-second lease lifetime starts at issuance. `maxTimeoutSeconds` is a separate payment field.

To pay, validate the approved origin/path, merchant, payer separation, network, asset, amount, subject, resource, audience, tools, budget, lifetime, schema and policy hash. Retry the same body at the returned quoted URL with an SDK-encoded `PAYMENT-SIGNATURE`. Echo the approved x402 resource, accepted requirements and extensions exactly. Use the existing agent purchase helpers; do not invent a transfer payload.

`extensions.scope402.info` contains exactly:

```text
version: 1
subject: { scheme: "p256", publicKey: "<subject SPKI>" }
audience: "https://scope402-auditlab.onrender.com/v1/tools"
resource: { kind: "canvas-region", canvasId: "<safe-world-slug>", x, y, width, height }
          or { kind: "github-repository", id: "owner/repo", revision: "<40-char SHA>" }
tools: ["place_pixel"] or ["finding_details"]
maxCalls: 12 or 3
ttlSeconds: 300
policyHash: "sha256:<64 lowercase hex characters>"
```

Root policy hash = `sha256:` + SHA-256 hex of RFC 8785/JCS canonical JSON of `info` **without `policyHash`**. The extension also includes an exact JSON schema; the reference agent checks it. Recomputing a hash for changed terms does not authorize a different purchase: the server compares against its persisted quote. Current reference clients accept the Scope402 extension shape strictly; adding another extension requires compatibility work.

The Hedera transfer does not itself cryptographically commit this policy. The application associates the persisted, validated policy with the settled quote.

## Purchase result and lease

HTTP 200 plus `PAYMENT-RESPONSE` is the successful paid response. Decode and validate the settlement header. Tessera's JSON body is:

```text
{ status: "complete", canvas_id: "<safe-world-slug>", region,
  payment: { payer, merchant, amount_tinybars, transaction, hashscan_url },
  lease: { token, lease_id, subject_pubkey, aud, catalogue_hash, tool_ids,
           max_calls, exp, offer_id, hedera_tx_id, policy_hash,
           resource, root_lease_id } }
```

AuditLab returns `status`, `scan_id`, `repo`, `commit_sha`, `findings`, `payment`, and `lease` (including `scan_id`). The raw `finding_details` API success is `{ lease_id, counter, finding }`; `FINDING_DETAILS_ALLOWED` is a hosted presentation label, not a raw API response field.

`token` is a compact service-signed ES256 JWS, type `scope402-lease+jws`. `exp` is a Unix timestamp in seconds. `offer_id` identifies the paid quote; `hedera_tx_id` identifies settlement. `catalogue_hash` is lowercase SHA-256 hex of JCS tool IDs. Remaining budget is authoritative database state, not a changing field in the signed token. Root `policy_hash` must equal the approved `info.policyHash`.

There is no public issuer-key/JWKS endpoint in the current discovery contract. The API verifies its own signature; independent clients must not describe decoding the token as offline signature verification.

## Signed invocation

Request body:

```text
{ lease: "<service-signed compact JWS>",
  args: { canvas_id: "<purchased-world-slug>", x: <integer>, y: <integer>, color: "<palette value>" },
  counter: <next positive safe integer>,
  signature: "<subject-signed compact JWS>" }
```

Tessera requires exactly these envelope properties and exactly the four shown arguments. Use the palette returned by the canvas endpoint. Canvas coordinates are integers 0–31, but only points inside the lease's rectangle are permitted: `x <= px < x + width`, likewise for y.

Sign this JWS payload with the capability subject's P-256 key:

```text
{ lease_id, tool_id: "place_pixel", counter,
  args_hash: "<lowercase SHA-256 hex of JCS(args), without sha256: prefix>",
  issued_at: <Unix seconds> }
```

The protected header is `{ alg: "ES256", subject_pubkey, typ: "scope402-invocation+jws" }`. JCS-encode header and payload; base64url-encode each without padding. Sign the bytes of `header.payload` with SHA-256/ECDSA, using 64-byte IEEE-P1363 `r || s` encoding (not ASN.1 DER), then append the base64url signature. Reference implementation: `apps/agent/src/subject.ts`.

`issued_at` must be within 120 seconds of the server clock. The first successful invocation uses counter 1; each successful new operation advances it by one. Denials do not advance the counter or consume budget. Serialize calls per lease. A fresh valid invocation may repaint the same coordinate: identical arguments alone are not a replay.

Success: `{ status: "PIXEL_PLACED", lease_id, counter, pixel: { canvas_id, x, y, color, updated_at }, remaining_calls }`. Pixel mutation and capability consumption commit in one database transaction. This local atomicity does not extend automatically to remote business APIs or Hedera settlement.

## Parent-signed delegation

The `delegation` JWS uses type `scope402-delegation+jws` and the same ES256/JCS/SPKI conventions as invocations. The **parent subject** signs exactly these terms:

```text
{ parent_lease_id, child_subject_pubkey,
  resource: { kind: "canvas-region", canvasId: "<purchased-world-slug>", x, y, width, height },
  tool_ids: ["place_pixel"], max_calls: <reserved child calls>,
  expires_at: <future Unix seconds no later than root expiry>,
  counter: <next delegation counter>, issued_at: <Unix seconds> }
```

The child subject must differ. Its rectangle must be contained and cannot equal the parent's entire rectangle; tools must be a nonempty unique subset. Requested calls must fit the root's unreserved balance. Equal expiry is allowed; child expiry must still be in the future. The delegation counter starts at 1 and is separate from the invocation counter. The same 120-second signature timestamp tolerance applies.

The server inherits audience, purchase, and payment lineage; these are not caller-selectable delegation fields. Only a root can delegate; grandchildren are rejected. Root expiry invalidates children. Reservations immediately reduce the root's available calls, even before the child acts. No reservation-refund mechanism is offered by this API.

Success: `{ status: "CAPABILITY_DELEGATED", lease: { token, ...childClaims }, parent: { lease_id, reserved_calls, remaining_calls, delegation_counter } }`. Child claims include `parent_lease_id`, unchanged `root_lease_id`, `offer_id`, and `hedera_tx_id`. The child gets its own policy hash; it is **not** expected to equal the root policy hash. The exact child-hash construction is in `apps/api/src/scope402/delegation.ts` (`childPolicyHash`).

## Retries, idempotency and errors

`Idempotency-Key` is optional on Tessera pixel and delegation routes only. Use a random UUID v4 per new operation. For delivery retries, preserve the same key and the exact signed body, including timestamp and signature. Stored successful results are returned without another mutation; they may be returned after expiry because they describe an earlier operation, not fresh permission. Reusing a key with different content/type is rejected with HTTP 401 `LEASE_REQUIRED`.

Without a matching stored receipt, reusing a consumed counter is HTTP 403 `REPLAY_DETECTED`. After the signature timestamp window or lease expiry, validation may reject earlier with a different error. A saved idempotent response is not evidence of a second successful invocation. Purchase recovery uses the same quote and signed payment, not `Idempotency-Key`.

| HTTP / code | Meaning and client action |
|---|---|
| 400 `INVALID_REQUEST`, `PAYMENT_INVALID`, `PAYMENT_REQUIREMENTS_MISMATCH`, `QUOTE_INVALID` | Fix input or stop on inconsistent purchase terms |
| 402 with `PAYMENT-REQUIRED` | Inspect quote; pay only under approved policy |
| 409 `QUOTE_EXPIRED`, `CANVAS_FULL`, `QUOTE_ALREADY_REDEEMED` | Inspect purchase state; never blindly create another payment |
| 409 `PLOT_IN_PROGRESS`, `PLOT_RESERVATION_LOST` | In-progress may be retried with the original payment; reservation loss needs investigation |
| 429 `QUOTE_RATE_LIMITED` | Respect `Retry-After`; stop creating new quotes |
| 502 payment/settlement error | Keep the signed payment and quote; uncertainty is not proof that no HBAR moved |
| 503 `PLOT_RETRYABLE` | Settled work can be retried with the original quote/body/payment header |
| 503 `PAYMENT_NOT_CONFIGURED`, `CANVAS_UNAVAILABLE` | Service/configuration failure; no success may be inferred |
| 401 `LEASE_REQUIRED` | Invalid envelope, signature, timestamp, idempotency key, or stored-claim mismatch |
| 403 `SUBJECT_KEY_MISMATCH`, `TOOL_NOT_ALLOWED`, `ARGUMENT_HASH_MISMATCH` | Correct the caller's key, tool or signature inputs |
| 403 `OUT_OF_SCOPE`, `INVALID_COLOR`, `BUDGET_EXHAUSTED` | Operation is outside current permitted scope/usage |
| 403 `CAPABILITY_ESCALATION_DENIED`, `CAPABILITY_BUDGET_EXCEEDED` | Delegation exceeds the permitted policy or available budget |
| 403 `REPLAY_DETECTED` | Counter already consumed or not the next expected counter |
| 410 `LEASE_EXPIRED` | No new action may execute under this expired authority |

This is not an exhaustive list of payment-provider errors. JSON errors normally contain `{ error, message }`; rate, body-limit, proxy and transport failures may differ. Check status and code, not prose. Completed paid retries return the original result and lease, which might now be expired; they do not renew permission. Keep any uncertain payment for reconciliation rather than signing a new transaction automatically.

## Supported boundary

Known-origin discovery is implemented. No Bazaar listing or facilitator directory integration is claimed. Browser hosted-run routes and protected demo-expiry controls are excluded from this public integration contract. There is no generic company-registration API, public service-key directory, or production multi-tenant control plane.
