import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lockfileFindings, repositoryCoordinates } from '../src/github.js'

test('extracts GitHub repository coordinates', () => {
  assert.deepEqual(repositoryCoordinates('https://github.com/0xshobha/scope402'),
    { owner: '0xshobha', repo: 'scope402' })
})

test('reports a missing root lockfile', () => {
  assert.deepEqual(lockfileFindings(['README.md', 'package.json']), [{
    id: 'missing-lockfile', severity: 'medium',
    message: 'No supported dependency lockfile exists at the repository root',
  }])
  assert.deepEqual(lockfileFindings(['package.json', 'pnpm-lock.yaml']), [])
  assert.deepEqual(lockfileFindings(['LICENSE', 'README.md']), [])
})
