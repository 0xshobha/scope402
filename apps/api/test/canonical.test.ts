import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canonicalJson } from '../src/canonical.js'

test('canonicalizes objects recursively with stable key order', () => {
  assert.equal(canonicalJson({ z: 1, a: { y: true, x: ['value', null] } }),
    '{"a":{"x":["value",null],"y":true},"z":1}')
})
