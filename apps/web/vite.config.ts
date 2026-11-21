import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// In development the Vite server stands in for nginx: one origin for the app, the API and
// the collaboration socket, matching production routing (design §12.4).
// `vite --mode stack` instead proxies everything through the running Compose stack's nginx (port 8000), with the
// Origin rewritten to the stack's own, so the API's and the collaboration service's origin checks accept it. Used to
// iterate on the UI against real data.
const STACK = 'http://localhost:8000'
const viaStack = { target: STACK, changeOrigin: true, headers: { Origin: STACK } }

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  resolve: {
    alias: [
      // y-monaco imports Monaco by a path that monaco-editor 0.57's exports map no longer exposes.
      // Point it at the same file, so both share one Monaco instance.
      {
        find: 'monaco-editor/esm/vs/editor/editor.api.js',
        replacement: fileURLToPath(import.meta.resolve('monaco-editor/editor/editor.api.js')),
      },
    ],
  },
  // Monaco's core is ~2.7 MB minified; it is split into the lazily loaded workspace route.
  build: { chunkSizeWarningLimit: 3000 },
  server: {
    port: 5173,
    proxy:
      mode === 'stack'
        ? { '/api': viaStack, '/ws': { ...viaStack, ws: true }, '/collab': { ...viaStack, ws: true } }
        : {
            '/api': 'http://localhost:8080',
            '/ws': { target: 'ws://localhost:8080', ws: true },
            '/collab': { target: 'ws://localhost:1234', ws: true, rewrite: (path) => path.replace(/^\/collab/, '') },
          },
  },
}))
