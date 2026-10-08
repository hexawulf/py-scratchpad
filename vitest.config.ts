import { defineConfig } from 'vitest/config'

// Unit tests only cover DOM-free logic (storage.ts takes a Storage-like
// object), so the default node environment is enough — no jsdom needed.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
})
