import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // No test may ever touch the real OS keychain by accident: file mode is
    // the suite-wide default, keychain tests opt out explicitly (and inject a
    // fake module anyway).
    env: { LUPIN_CREDSTORE: 'file' },
  },
});
