import assert from 'node:assert/strict'
import { createPublicKey, verify } from 'node:crypto'
import { test } from 'node:test'
import { attackerSubject } from '../src/subject.js'

test('creates an ephemeral subject whose invocation signature is verifiable', () => {
  const attacker = attackerSubject()
  const invocation = { lease_id: 'lease', tool_id: 'finding_details', counter: 1,
    args_hash: 'hash', issued_at: 1 }
  const compact = attacker.sign(invocation)
  const [header, payload, signature] = compact.split('.') as [string, string, string]
  const protectedHeader = JSON.parse(Buffer.from(header, 'base64url').toString())
  assert.equal(protectedHeader.subject_pubkey, attacker.subjectPubkey)
  const publicKey = createPublicKey({
    key: Buffer.from(attacker.subjectPubkey, 'base64url'), format: 'der', type: 'spki',
  })
  assert.equal(verify('sha256', Buffer.from(`${header}.${payload}`),
    { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')), true)
  assert.notEqual(attackerSubject().subjectPubkey, attacker.subjectPubkey)
})
