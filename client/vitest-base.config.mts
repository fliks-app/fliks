import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    isolate: false,
    setupFiles: ['./vitest-setup.mts'],
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
  },
});
