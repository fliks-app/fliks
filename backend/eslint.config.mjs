// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },
  {
    // Core must not import plugins/download/; ignores list is the known
    // pre-fence importers still crossing it — new code must not join them.
    files: ['src/**/*.ts'],
    ignores: [
      'src/plugins/download/**',
      'src/app.module.ts',
      // Test-only: both construct the bundle's publisher to prove core's own
      // path produces the same effects. They leave when the bundle does.
      'src/modules/plugins/host/fliks-host.service.spec.ts',
      'src/modules/counts/counts.service.spec.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/plugins/download/**'],
              message:
                'Core does not import plugins/download/ — inject the capability instead. Known pre-fence importers are allowlisted in eslint.config.mjs.',
            },
          ],
        },
      ],
    },
  },
  {
    // plugins/download/** reaches core only through common/plugin-contract (and
    // the host client wired up under modules/plugins/host/); ignores list is
    // every current importer of a not-yet-converted core dependency (PR 10.1b).
    files: ['src/plugins/download/**/*.ts'],
    ignores: [
      'src/plugins/download/acquisition-scheduler.service.ts',
      'src/plugins/download/auto-grab-pipeline.service.ts',
      'src/plugins/download/blocklist/blocklist.controller.ts',
      'src/plugins/download/blocklist/blocklist.module.ts',
      'src/plugins/download/blocklist/blocklist.service.ts',
      'src/plugins/download/blocklist/entities/blocklist-entry.entity.ts',
      'src/plugins/download/completion.service.spec.ts',
      'src/plugins/download/acquisition-events.service.ts',
      'src/plugins/download/completion.service.ts',
      'src/plugins/download/download-bundle.module.ts',
      'src/plugins/download/download-clients/download-clients.controller.ts',
      'src/plugins/download/download-clients/download-clients.module.ts',
      'src/plugins/download/download-clients/download-clients.service.ts',
      'src/plugins/download/download-clients/entities/download-client.entity.ts',
      'src/plugins/download/download-clients/qbittorrent.service.ts',
      'src/plugins/download/entities/download-history.entity.ts',
      'src/plugins/download/episode-download.service.ts',
      'src/plugins/download/grab.controller.ts',
      'src/plugins/download/grab-history.util.ts',
      'src/plugins/download/grab.module.ts',
      'src/plugins/download/indexers/entities/indexer.entity.ts',
      'src/plugins/download/indexers/indexers.controller.ts',
      'src/plugins/download/indexers/indexers.module.ts',
      'src/plugins/download/indexers/torznab.service.ts',
      'src/plugins/download/movie-download.service.ts',
      'src/plugins/download/torrent-auto-matcher.service.ts',
      'src/plugins/download/torrent-history-matcher.service.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/modules/**',
                '**/common/**',
                // gitignore semantics: a path can't be un-excluded while its
                // parent still is, so every intermediate segment needs its own
                // negation, not just the two leaf directories.
                '!**/common',
                '!**/common/plugin-contract',
                '!**/common/plugin-contract/**',
                '!**/modules',
                '!**/modules/plugins',
                '!**/modules/plugins/host',
                '!**/modules/plugins/host/**',
              ],
              message:
                'plugins/download/** reaches core only through common/plugin-contract (or the host client under modules/plugins/host/) — inject that instead. Known pre-fence importers are allowlisted in eslint.config.mjs.',
            },
          ],
        },
      ],
    },
  },
);
