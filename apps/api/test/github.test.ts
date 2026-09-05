import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lockfileFindings, repositoryCoordinates, scanRepositorySnapshot } from '../src/github.js'

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

test('scans the exact stored repository snapshot', () => {
  const snapshot = {
    repo: '0xshobha/scope402', commit_sha: 'a'.repeat(40),
    root_files: ['README.md', 'package.json'],
  }
  const scan = scanRepositorySnapshot(snapshot)
  assert.equal(scan.repo, snapshot.repo)
  assert.equal(scan.commit_sha, snapshot.commit_sha)
  assert.equal(scan.findings[0]?.id, 'missing-lockfile')
})
