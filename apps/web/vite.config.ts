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
    proxy: {
      '/auditlab': {
        target: 'https://scope402-auditlab.onrender.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/auditlab/, ''),
      },
      '/demo-agent': {
        target: 'https://scope402-demo-agent.onrender.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/demo-agent/, ''),
      },
    },
  },
})
