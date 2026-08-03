import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e-sandbox',
  testMatch: '**/*.pw.ts',
  workers: 1,
  timeout: 45_000,
  outputDir: '../../output/playwright/sandbox',
  reporter: 'line',
  use: {
    baseURL: process.env.MEMEBOT_ARCHIVE_WEBUI_URL,
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
})
