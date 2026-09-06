import { isIP } from 'node:net'

export type TrustedProxy = 'none' | 'render'

export function trustedProxy(value = process.env.AUDITLAB_TRUSTED_PROXY ??
  (process.env.RENDER === 'true' ? 'render' : 'none')): TrustedProxy {
  if (value === 'none') return 'none'
  if (value === 'render') return 'render'
  throw new Error('AUDITLAB_TRUSTED_PROXY must be none or render')
}

type ProxyHeaders = { cloudflare?: string; forwarded?: string; real?: string }

export function quoteClientIdentity(headers: ProxyHeaders,
  proxy = trustedProxy()): string {
  if (proxy !== 'render') return 'unknown'
  // Render's Cloudflare edge overwrites CF-Connecting-IP. X-Forwarded-For is
  // appended and X-Real-IP is caller-controlled, so neither may identify a quota bucket.
  const address = headers.cloudflare?.trim() ?? ''
  return isIP(address) ? address : 'unknown'
}
