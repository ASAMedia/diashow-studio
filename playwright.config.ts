import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  timeout: 600_000,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results'
})
