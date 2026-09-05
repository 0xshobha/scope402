import { createPublicKey } from 'node:crypto'

export function assertP256Subject(value: unknown) {
  if (typeof value !== 'string') {
    throw new Error('subject_pubkey must be a base64url-encoded P-256 SPKI public key')
  }
  try {
    const key = createPublicKey({ key: Buffer.from(value, 'base64url'), format: 'der', type: 'spki' })
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new Error('Wrong curve')
    }
  } catch {
    throw new Error('subject_pubkey must be a base64url-encoded P-256 SPKI public key')
  }
  return value
}
