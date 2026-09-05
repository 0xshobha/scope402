import type { TransactionClient } from '../db.js'
import { LeaseError } from '../lease-error.js'
import { hashArgs, type Scope402Invocation } from './invocation.js'
import type { BaseLeaseClaims } from './lease.js'
import { exactPolicyEcho } from './policy.js'
import { consumeCapability, lockCapability, type LockedCapabilityState } from './store.js'

export type AuthorizationContext<Args> = {
  claims: BaseLeaseClaims
  invocation: Scope402Invocation
  args: Args
  state: LockedCapabilityState
}

export type ResourceAdapter<Args, Authorized, Result> = {
  authorizeResourceAction(client: TransactionClient,
    context: AuthorizationContext<Args>): Promise<Authorized>
  commitBusinessMutation(client: TransactionClient, context: AuthorizationContext<Args>,
    authorized: Authorized): Promise<Result>
}

export async function authorizeAndCommitInTransaction<Args, Authorized, Result>(
  client: TransactionClient,
  claims: BaseLeaseClaims,
  invocation: Scope402Invocation,
  args: Args,
  adapter: ResourceAdapter<Args, Authorized, Result>,
  options: { allowLegacyUnscopedState?: boolean } = {},
) {
  if (invocation.lease_id !== claims.lease_id) {
    throw new LeaseError('LEASE_REQUIRED', 'Invocation is for another lease')
  }
  if (!claims.tool_ids.includes(invocation.tool_id)) {
    throw new LeaseError('TOOL_NOT_ALLOWED', 'Invocation is for another tool')
  }
  if (invocation.args_hash !== hashArgs(args)) {
    throw new LeaseError('ARGUMENT_HASH_MISMATCH', 'Signed arguments do not match the request')
  }
  const state = await lockCapability(client, claims.lease_id)
  if (!state || state.subjectPubkey !== claims.subject_pubkey) {
    throw new LeaseError('SUBJECT_KEY_MISMATCH', 'Lease subject does not match stored state')
  }
  if (state.policyHash !== claims.policy_hash) {
    throw new LeaseError('LEASE_REQUIRED', 'Lease policy does not match stored state')
  }
  if (state.hederaTransactionId !== claims.hedera_tx_id) {
    throw new LeaseError('LEASE_REQUIRED', 'Lease payment transaction does not match stored state')
  }
  const legacyUnscoped = state.formatVersion === undefined
  if (legacyUnscoped && (claims.resource !== undefined || !options.allowLegacyUnscopedState)) {
    throw new LeaseError('LEASE_REQUIRED', 'Lease has no persisted resource policy')
  }
  if (!legacyUnscoped && (![1, 2].includes(state.formatVersion ?? 0) || state.audience !== claims.aud ||
      state.catalogueHash !== claims.catalogue_hash ||
      !exactPolicyEcho(state.toolIds, claims.tool_ids) ||
      !exactPolicyEcho(state.resource, claims.resource))) {
    throw new LeaseError('LEASE_REQUIRED', 'Lease claims do not match stored state')
  }
  if (state.formatVersion === 2 && state.paymentQuoteId !== claims.offer_id) {
    throw new LeaseError('LEASE_REQUIRED', 'Lease payment lineage does not match stored state')
  }
  if (state.expired || claims.exp <= Math.floor(Date.now() / 1000)) {
    throw new LeaseError('LEASE_EXPIRED', 'Lease has expired')
  }
  if (state.expiresAt !== claims.exp || state.maxCalls !== claims.max_calls) {
    throw new LeaseError('LEASE_REQUIRED', 'Lease claims do not match stored state')
  }
  if (invocation.counter <= state.lastCounter || invocation.counter !== state.lastCounter + 1) {
    throw new LeaseError('REPLAY_DETECTED', 'Invocation counter was already used')
  }
  if (state.usedCalls >= state.maxCalls) {
    throw new LeaseError('BUDGET_EXHAUSTED', 'Lease call budget is exhausted')
  }
  const context = { claims, invocation, args, state }
  const authorized = await adapter.authorizeResourceAction(client, context)
  const consumed = await consumeCapability(client, state, invocation.counter)
  if (consumed.kind === 'expired') {
    throw new LeaseError('LEASE_EXPIRED', 'Lease expired before the operation committed')
  }
  if (consumed.kind === 'replay') {
    throw new LeaseError('REPLAY_DETECTED', 'Invocation counter is not the next counter')
  }
  if (consumed.kind === 'exhausted') {
    throw new LeaseError('BUDGET_EXHAUSTED', 'Lease call budget is exhausted')
  }
  if (consumed.kind !== 'consumed') {
    throw new LeaseError('LEASE_REQUIRED', 'Lease state changed before the operation committed')
  }
  return adapter.commitBusinessMutation(client, context, authorized)
}

export type { LockedCapabilityState } from './store.js'
