import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  resolve: {
    // Keep standalone package tests on Koishi's runtime core; the aggregate
    // entry in koishi@4.18.11 misloads its CommonJS loader under Vitest ESM.
    alias: [{ find: /^koishi$/, replacement: '@koishijs/core' }],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    lib: { entry: resolve(__dirname, 'client/index.ts'), formats: ['es'], fileName: () => 'index.js' },
    rollupOptions: { external: ['@koishijs/client', 'vue'] },
  },
})
