import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Remove once the first core tests land.
    passWithNoTests: true
  }
})
