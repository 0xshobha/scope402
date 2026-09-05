import type { TransactionClient } from '../db.js'
import { LeaseError } from '../lease-error.js'
import type { BaseLeaseClaims } from './lease.js'
import type { Scope402Invocation } from './invocation.js'

export type LockedCapabilityState = {
  subjectPubkey: string
  policyHash?: string
  expiresAt: number
  expired: boolean
  usedCalls: number
  maxCalls: number
  lastCounter: number
}

export type CapabilityStore<State extends LockedCapabilityState> = {
  lock(client: TransactionClient, leaseId: string): Promise<State | undefined>
  consume(client: TransactionClient, state: State, counter: number): Promise<boolean>
}

export type ResourceAdapter<State extends LockedCapabilityState, Authorized, Result> = {
  authorizeResourceAction(client: TransactionClient, state: State): Promise<Authorized>
  commitBusinessMutation(client: TransactionClient, state: State, authorized: Authorized): Promise<Result>
}

export async function authorizeAndCommitInTransaction<
  State extends LockedCapabilityState,
  Authorized,
  Result,
>(
  client: TransactionClient,
  claims: BaseLeaseClaims,
  invocation: Scope402Invocation,
  store: CapabilityStore<State>,
  adapter: ResourceAdapter<State, Authorized, Result>,
) {
  if (invocation.lease_id !== claims.lease_id) {
    throw new LeaseError('LEASE_REQUIRED', 'Invocation is for another lease')
  }
  if (!claims.tool_ids.includes(invocation.tool_id)) {
    throw new LeaseError('TOOL_NOT_ALLOWED', 'Invocation is for another tool')
  }
  const state = await store.lock(client, claims.lease_id)
  if (!state || state.subjectPubkey !== claims.subject_pubkey) {
    throw new LeaseError('SUBJECT_KEY_MISMATCH', 'Lease subject does not match stored state')
  }
  if (state.policyHash !== claims.policy_hash) {
    throw new LeaseError('LEASE_REQUIRED', 'Lease policy does not match stored state')
  }
  if (state.expired || claims.exp <= Math.floor(Date.now() / 1000)) {
    throw new LeaseError('LEASE_EXPIRED', 'Lease has expired')
  }
  if (state.expiresAt !== claims.exp || state.maxCalls !== claims.max_calls) {
    throw new LeaseError('LEASE_REQUIRED', 'Lease claims do not match stored state')
  }
  if (invocation.counter <= state.lastCounter) {
    throw new LeaseError('REPLAY_DETECTED', 'Invocation counter was already used')
  }
  if (state.usedCalls >= state.maxCalls) {
    throw new LeaseError('BUDGET_EXHAUSTED', 'Lease call budget is exhausted')
  }
  const authorized = await adapter.authorizeResourceAction(client, state)
  if (invocation.counter !== state.lastCounter + 1) {
    throw new LeaseError('REPLAY_DETECTED', 'Invocation counter is not the next counter')
  }
  if (!await store.consume(client, state, invocation.counter)) {
    throw new LeaseError('LEASE_EXPIRED', 'Lease expired before the operation committed')
  }
  return adapter.commitBusinessMutation(client, state, authorized)
}
