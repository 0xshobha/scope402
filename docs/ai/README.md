# AI-assisted development disclosure

Scope402 was designed and built by Shobha Vashishtha during ETHOnline 2026. AI tools were used as
development accelerators, not as runtime dependencies or sources of proof.

## Tools and uses

- **ChatGPT and research tools:** compared possible directions, checked public documentation, challenged
  product claims, and helped refine the payment-versus-authorization framing.
- **Claude and Codex-family coding agents:** assisted with TypeScript implementation, test generation,
  debugging, security review, documentation, and deployment verification under human direction.
- **Human-controlled work:** architecture choices, scope cuts, account/key custody, real testnet payments,
  deployment authorization, claim approval, submission decisions, and final voiceover.

## Verification boundary

AI output is not treated as evidence. Claims in the README are backed by repository tests, public HTTP
responses, persisted state, or the named Hedera testnet transactions. The browser demo contains no model
inference and does not simulate settlement, capability issuance, delegation, or denial outcomes.

## Guardrails

- No private payment, subject, merchant, GitHub, or demo-control key was placed in prompts or committed.
- The browser never receives signing keys, payment payloads, lease tokens, or invocation signatures.
- The scanner does not execute repository code and does not ask an LLM to invent vulnerabilities.
- The final narration is recorded by the team; no synthetic voice is used.

See [DESIGN-DECISIONS.md](DESIGN-DECISIONS.md) for the human-directed invariants used during implementation.
