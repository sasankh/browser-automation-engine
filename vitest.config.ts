import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Browser-driven integration tests need headroom for Chromium launch + navigation.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
