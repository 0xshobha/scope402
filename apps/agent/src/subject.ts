import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export async function subjectPublicKey() {
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
  const key = createPrivateKey(pem)
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('Stored capability key must be P-256')
  }
  return createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64url')
}
