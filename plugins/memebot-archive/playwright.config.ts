import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.pw.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  outputDir: '../../output/playwright/archive',
  reporter: 'line',
  use: {
    baseURL: process.env.MEMEBOT_ARCHIVE_WEBUI_URL,
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    storageState: process.env.MEMEBOT_ARCHIVE_AUTH_STORAGE_STATE,
  },
})
