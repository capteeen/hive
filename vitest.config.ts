import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
      // the real package throws outside React Server Components
      'server-only': path.resolve(__dirname, 'tests/stubs/server-only.ts'),
    },
  },
});
