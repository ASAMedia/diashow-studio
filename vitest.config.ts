import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: { include: ['tests/**/*.test.ts'], globalSetup: ['tests/globalSetup.ts'], testTimeout: 120_000 }
})
