import { defineConfig } from 'vitest/config';

// Backend tests that need no database. The frontend's specs need Angular's test
// builder; tests/db/ needs a MariaDB (vitest.db.config.ts).
export default defineConfig({
  test: {
    include: ['tests/**/*.{test,spec}.ts', 'src/**/*.{test,spec}.ts'],
    exclude: ['node_modules/**', 'dist/**', 'frontend/**', 'tests/db/**'],
  },
});
