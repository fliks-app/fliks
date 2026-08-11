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
      'src/modules/media/auto-grab-pipeline.service.ts',
      'src/modules/scheduler/scheduler.module.ts',
      'src/modules/scheduler/scheduler.service.ts',
      'src/modules/scheduler/system.controller.ts',
      'src/modules/blocklist/blocklist.module.ts',
      'src/modules/blocklist/blocklist.service.ts',
      'src/modules/auth/casl/casl-ability.factory.ts',
      'src/modules/setup-checklist/setup-checklist.module.ts',
      'src/modules/setup-checklist/setup-checklist.service.ts',
      'src/modules/plugins/proxy/policy-vocabulary.ts',
      'src/modules/counts/counts.module.ts',
      'src/modules/counts/counts.service.ts',
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
);
