import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/auditlab': {
        target: 'https://scope402-auditlab.onrender.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/auditlab/, ''),
      },
    },
  },
})
