import { defineConfig } from 'vitest/config';

// Backend tests only. The frontend's specs need Angular's test builder
// (`ng test`) and fail under bare vitest.
export default defineConfig({
  test: {
    include: ['tests/**/*.{test,spec}.ts', 'src/**/*.{test,spec}.ts'],
    exclude: ['node_modules/**', 'dist/**', 'frontend/**'],
  },
});
