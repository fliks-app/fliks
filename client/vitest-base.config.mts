import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    isolate: false,
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
  },
});
