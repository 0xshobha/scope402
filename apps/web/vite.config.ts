import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        demo: resolve(import.meta.dirname, 'demo/index.html'),
        tessera: resolve(import.meta.dirname, 'tessera/index.html'),
      },
    },
  },
  server: {
    // Keep the public hosted agent as the default, while allowing a developer
    // to run the same guarded agent locally for a complete end-to-end check.
    // No credentials are read by the browser; this only changes the dev proxy.
    proxy: {
      '/auditlab': {
        target: 'https://scope402-auditlab.onrender.com',
        changeOrigin: true,
        timeout: 35_000,
        proxyTimeout: 35_000,
        rewrite: (path) => path.replace(/^\/auditlab/, ''),
      },
      '/demo-agent': {
        target: process.env.VITE_TESSERA_AGENT_URL ?? process.env.VITE_DEMO_AGENT_URL ??
          'https://scope402-demo-agent.onrender.com',
        changeOrigin: true,
        timeout: 35_000,
        proxyTimeout: 35_000,
        rewrite: (path) => path.replace(/^\/demo-agent/, ''),
      },
    },
  },
})
