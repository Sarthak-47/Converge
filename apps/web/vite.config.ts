import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// In development the Vite server stands in for nginx: one origin for the app, the API and
// the collaboration socket, matching production routing (design §12.4).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
      '/ws': { target: 'ws://localhost:8080', ws: true },
      '/collab': { target: 'ws://localhost:1234', ws: true, rewrite: (path) => path.replace(/^\/collab/, '') },
    },
  },
})
