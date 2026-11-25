import { defineConfig } from 'vitest/config'
import preact from '@preact/preset-vite'
import { resolve } from 'node:path'

// Relative paths throughout, so the same build works at a domain root, in a sub-folder
// (GitHub Pages) and inside the Windows app.
export default defineConfig({
  base: './',
  plugins: [preact()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        pill: resolve(import.meta.dirname, 'pill.html'),
        harness: resolve(import.meta.dirname, 'harness.html'),
      },
    },
  },
  worker: { format: 'es' },
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
})
