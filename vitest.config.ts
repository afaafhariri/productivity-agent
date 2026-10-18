import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Remove once the first core tests land (Phase 0, step 3).
    passWithNoTests: true
  }
})
