import { randomUUID } from 'node:crypto'

const lockfiles = new Set([
  'bun.lock', 'bun.lockb', 'composer.lock', 'deno.lock', 'Gemfile.lock',
  'package-lock.json', 'pnpm-lock.yaml', 'poetry.lock', 'uv.lock', 'yarn.lock',
])
const manifests = new Set([
  'composer.json', 'deno.json', 'deno.jsonc', 'Gemfile', 'package.json',
  'Pipfile', 'pyproject.toml', 'requirements.txt',
])

type Repository = { default_branch?: unknown; full_name?: unknown }
type Branch = { commit?: { sha?: unknown } }
type Content = { name?: unknown; type?: unknown }

export type Finding = {
  id: 'missing-lockfile'
  severity: 'medium'
  message: string
}

export function repositoryCoordinates(repoUrl: string) {
  const parts = new URL(repoUrl).pathname.replace(/\/$/, '').split('/').slice(1)
  if (parts.length !== 2) throw new Error('Invalid GitHub repository URL')
  return { owner: parts[0]!, repo: parts[1]! }
}

export function lockfileFindings(rootFiles: string[]): Finding[] {
  if (!rootFiles.some((name) => manifests.has(name))) return []
  if (rootFiles.some((name) => lockfiles.has(name))) return []
  return [{ id: 'missing-lockfile', severity: 'medium',
    message: 'No supported dependency lockfile exists at the repository root' }]
}

async function github<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Scope402-AuditLab',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const response = await fetch(`https://api.github.com${path}`, {
    headers, redirect: 'error', signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    const suffix = response.headers.get('x-ratelimit-remaining') === '0' ? ' (rate limit exhausted)' : ''
    throw new Error(`GitHub API returned ${response.status}${suffix}`)
  }
  return response.json() as Promise<T>
}

export async function scanRepository(repoUrl: string) {
  const { owner, repo } = repositoryCoordinates(repoUrl)
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
  const metadata = await github<Repository>(base)
  if (typeof metadata.default_branch !== 'string' || typeof metadata.full_name !== 'string') {
    throw new Error('GitHub returned malformed repository metadata')
  }
  const branch = await github<Branch>(`${base}/branches/${encodeURIComponent(metadata.default_branch)}`)
  const sha = branch.commit?.sha
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error('GitHub returned a malformed commit SHA')
  }
  const contents = await github<Content[]>(`${base}/contents?ref=${sha}`)
  if (!Array.isArray(contents)) throw new Error('GitHub repository root is not a directory')
  const files = contents.filter((entry) => entry.type === 'file' && typeof entry.name === 'string')
    .map((entry) => entry.name as string)
  return {
    scan_id: randomUUID(),
    repo: metadata.full_name,
    commit_sha: sha,
    findings: lockfileFindings(files),
  }
}
