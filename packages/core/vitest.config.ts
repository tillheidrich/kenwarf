import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'pruefung/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 30000,
    pool: 'forks',
  },
});
