import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  resolve: { alias: { '@kern/server': fileURLToPath(new URL('../server/src/index.ts', import.meta.url)) } },
  test: { include: ['test/**/*.test.ts'], testTimeout: 60000, pool: 'forks' },
});
