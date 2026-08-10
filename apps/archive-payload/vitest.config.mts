import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Backend #59 may land service tests in parallel; exclude until that module is integrated.
    exclude: ['**/node_modules/**', '**/service.test.ts'],
  },
})
