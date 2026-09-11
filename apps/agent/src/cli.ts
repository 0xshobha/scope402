#!/usr/bin/env node

import { pathToFileURL } from 'node:url'
import { Scope402Client } from './sdk.js'

type Write = (value: string) => void

const usage = `Scope402 agent CLI

Usage:
  scope402 worlds [--api <url>]
  scope402 world <canvas-id> [--api <url>]
  scope402 watch <canvas-id> [--api <url>]

These commands are read-only. watch emits one compact JSON snapshot per line until interrupted.
They never create a quote or move HBAR.
The default API is https://scope402-auditlab.onrender.com.`

function argumentsFor(argv: string[]) {
  const args = [...argv]
  let api = process.env.AUDITLAB_URL ?? 'https://scope402-auditlab.onrender.com'
  const apiIndex = args.indexOf('--api')
  if (apiIndex >= 0) {
    const value = args[apiIndex + 1]
    if (!value) throw new Error('--api requires an HTTPS or local HTTP URL')
    api = value
    args.splice(apiIndex, 2)
  }
  const url = new URL(api)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '::1'].includes(url.hostname))) {
    throw new Error('--api must use HTTPS, except for a local development URL')
  }
  return { args, api: url }
}

export async function runCli(argv: string[], output: Write = console.log,
  errorOutput: Write = console.error, request: typeof fetch = fetch) {
  try {
    const { args, api } = argumentsFor(argv)
    const [command, canvasId, extra] = args
    if (!command || command === 'help' || command === '--help' || command === '-h') {
      output(usage)
      return 0
    }
    if (extra || ((command === 'world' || command === 'watch') && !canvasId)) {
      throw new Error('Invalid command arguments')
    }
    const client = new Scope402Client({ auditLabUrl: api }, request)
    if (command === 'worlds') {
      if (canvasId) throw new Error('worlds accepts no canvas ID')
      output(JSON.stringify({ api: api.href, canvases: await client.listTesseraWorlds() }, null, 2))
      return 0
    }
    if (command === 'world') {
      output(JSON.stringify(await client.readTesseraWorld(canvasId!), null, 2))
      return 0
    }
    if (command === 'watch') {
      for await (const world of client.watchTesseraWorld(canvasId!)) output(JSON.stringify(world))
      return 0
    }
    throw new Error(`Unknown command: ${command}`)
  } catch (error) {
    errorOutput(error instanceof Error ? error.message : 'Scope402 command failed')
    errorOutput('Run scope402 help for usage.')
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(process.argv.slice(2))
}
