import { serve } from '@hono/node-server'
import { app } from './app.js'

const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 3000 }, (info) => {
  console.log(`AuditLab listening on http://127.0.0.1:${info.port}`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close((error) => {
      if (error) {
        console.error(error)
        process.exitCode = 1
      }
    })
  })
}
