import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts (which is renderer-rooted for the app build).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
