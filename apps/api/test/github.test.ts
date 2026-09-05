import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clearRepositoryCache, lockfileFindings, prepareRepository, repositoryCoordinates,
  scanRepositorySnapshot } from '../src/github.js'

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

test('deduplicates GitHub reads, caches immutable snapshots, and falls back on an outage', async (t) => {
  clearRepositoryCache()
  let now = 1_000
  const originalNow = Date.now
  const originalFetch = globalThis.fetch
  let calls = 0
  let unavailable = false
  Date.now = () => now
  globalThis.fetch = (async (input) => {
    calls += 1
    if (unavailable) return new Response('{}', { status: 503 })
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname
    const body = path.endsWith('/branches/main') ? { commit: { sha: 'b'.repeat(40) } } :
      path.endsWith('/contents') ? [{ name: 'package.json', type: 'file' }] :
        { default_branch: 'main', full_name: '0xshobha/scope402' }
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  t.after(() => {
    Date.now = originalNow
    globalThis.fetch = originalFetch
    clearRepositoryCache()
  })

  const [first, concurrent] = await Promise.all([
    prepareRepository('https://github.com/0xshobha/scope402'),
    prepareRepository('https://github.com/0xshobha/scope402'),
  ])
  assert.deepEqual(concurrent, first)
  assert.equal(calls, 3)
  assert.deepEqual(await prepareRepository('https://github.com/0xshobha/scope402'), first)
  assert.equal(calls, 3)

  now += 60_001
  assert.deepEqual(await prepareRepository('https://github.com/0xshobha/scope402'), first)
  assert.equal(calls, 5)

  now += 60_001
  unavailable = true
  assert.deepEqual(await prepareRepository('https://github.com/0xshobha/scope402'), first)
  assert.equal(calls, 6)
})
