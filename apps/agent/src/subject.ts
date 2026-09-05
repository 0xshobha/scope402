import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { canonicalJson } from './canonical.js'

async function subjectKey() {
  const directory = join(homedir(), '.config', 'scope402')
  const file = join(directory, 'subject.pem')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  let pem: string
  try {
    pem = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    try {
      await writeFile(file, pem, { flag: 'wx', mode: 0o600 })
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError
      pem = await readFile(file, 'utf8')
    }
  }
  const mode = (await stat(file)).mode & 0o777
  if (mode !== 0o600) await chmod(file, 0o600)
  const key = createPrivateKey(pem)
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('Stored capability key must be P-256')
  }
  return key
}

export async function subjectPublicKey() {
  return createPublicKey(await subjectKey()).export({ type: 'spki', format: 'der' }).toString('base64url')
}

export function signInvocationWithKey(invocation: object, key: KeyObject) {
  const subject_pubkey = createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64url')
  const header = Buffer.from(canonicalJson({ alg: 'ES256', subject_pubkey,
    typ: 'scope402-invocation+jws' })).toString('base64url')
  const payload = Buffer.from(canonicalJson(invocation)).toString('base64url')
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`),
    { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')
  return { signature: `${header}.${payload}.${signature}`, subjectPubkey: subject_pubkey }
}

function subjectFromKey(key: KeyObject) {
  const subjectPubkey = createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64url')
  return {
    subjectPubkey,
    sign(invocation: object) {
      return signInvocationWithKey(invocation, key).signature
    },
  }
}

export type AgentSubject = ReturnType<typeof subjectFromKey>

export async function persistentSubject(): Promise<AgentSubject> {
  return subjectFromKey(await subjectKey())
}

export function ephemeralSubject(): AgentSubject {
  return subjectFromKey(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey)
}

export async function signInvocation(invocation: object) {
  return signInvocationWithKey(invocation, await subjectKey()).signature
}

export function attackerSubject() {
  return ephemeralSubject()
}
