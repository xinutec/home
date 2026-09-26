import { defineConfig } from 'vitest/config';

// Tests against a real MariaDB, run by the gate under with-test-db. They share
// one database, so files run one at a time.
export default defineConfig({
  test: {
    include: ['tests/db/**/*.test.ts'],
    fileParallelism: false,
  },
});
