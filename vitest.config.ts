import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // koishi@4.18.11's ESM aggregate currently loads the CommonJS loader
    // default as a namespace object. Tests only need Koishi's runtime core.
    alias: [{ find: /^koishi$/, replacement: '@koishijs/core' }],
  },
  test: {
    // The Payload app is an independent Yarn project with its own lockfile
    // and Vitest configuration. Its tests run from the app directory in CI;
    // discovering them from this root config makes a clean root install fail
    // before the app's dependencies are installed.
    exclude: [...configDefaults.exclude, 'apps/archive-payload/**'],
  },
})
