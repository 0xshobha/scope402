import { getHederaSupport } from './blocky.js'

try {
  const support = await getHederaSupport()
  console.log('Blocky402: reachable')
  console.log(`Network: ${support.network}`)
  console.log(`x402: v${support.x402Version}`)
  console.log(`Fee payer: ${support.extra.feePayer}`)
} catch (error) {
  console.error('Blocky402 check failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
}
