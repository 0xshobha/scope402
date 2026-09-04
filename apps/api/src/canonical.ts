import canonicalize from 'canonicalize'

export function canonicalJson(value: unknown): string {
  const result = canonicalize(value)
  if (result === undefined) throw new Error('Value cannot be represented as canonical JSON')
  return result
}
