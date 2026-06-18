import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Browser-driven integration tests need headroom for Chromium launch + navigation.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Many integration files each launch a Chromium pool (+ hit LocalStack/Postgres); cap parallelism
    // so concurrent browsers don't oversubscribe the box and flake under load. Unit tests stay fast.
    maxWorkers: '50%',
    minWorkers: 1,
  },
});
