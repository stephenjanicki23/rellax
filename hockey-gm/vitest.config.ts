import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 1_800_000,
    hookTimeout: 1_800_000,
  },
});
