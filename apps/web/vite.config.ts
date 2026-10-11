import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// In development the Vite server stands in for nginx: one origin for the app, the API and
// the collaboration socket, matching production routing (design §12.4).
export default defineConfig({
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
    proxy: {
      '/api': 'http://localhost:8080',
      '/ws': { target: 'ws://localhost:8080', ws: true },
      '/collab': { target: 'ws://localhost:1234', ws: true, rewrite: (path) => path.replace(/^\/collab/, '') },
    },
  },
})
