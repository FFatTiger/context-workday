import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['test/**/*.test.ts', 'web/src/**/*.test.{ts,tsx}'], pool: 'forks', maxWorkers: 2 },
})
