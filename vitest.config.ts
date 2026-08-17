import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // koishi@4.18.11's ESM aggregate currently loads the CommonJS loader
    // default as a namespace object. Tests only need Koishi's runtime core.
    alias: [{ find: /^koishi$/, replacement: '@koishijs/core' }],
  },
  test: {
    exclude: [...configDefaults.exclude],
  },
})
