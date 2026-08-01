import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.pw.ts',
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: process.env.MEMEBOT_ARCHIVE_WEBUI_URL,
    headless: true,
  },
})
