# Human-directed design decisions

These invariants constrained AI-assisted implementation and review:

1. **Payment is not authorization.** Hedera proves value moved; the merchant independently enforces later
   authority.
2. **Policy exists before payment.** The x402 response contains the subject, resource, tool set, call budget,
   lifetime, and policy hash that the agent validates before signing.
3. **No browser keys.** A separate, policy-locked testnet agent owns payment and P-256 subject keys.
4. **Useful work is real.** AuditLab scans an exact public GitHub commit; Tessera mutates server-authoritative
   canvas state.
5. **Capabilities fail closed.** Wrong subject, replay, expiry, exhausted budget, resource escape, and
   privilege escalation are denied by the API.
6. **State transitions are atomic.** Capability consumption and the merchant mutation commit in one
   PostgreSQL transaction.
7. **Delegation only narrows.** A child may change to a distinct subject while narrowing resource, tool set,
   budget, and expiry; it cannot change audience, canvas, or payment lineage.
8. **Evidence boundaries remain explicit.** Local tests, public deployment, facilitator settlement, and
   Hedera Mirror Node confirmation are separate claims.

Historical exploratory prompts are intentionally not copied into the product repository because they contain
rejected ideas and obsolete implementation states. The concise disclosure records the tools used and the
constraints that governed the shipped system.
