// @ts-check
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

/** The acquisition plugin's own routes — core must reach them through its
 *  contract, never a literal path. */
const FORBIDDEN_PREFIXES = ['/api/indexers', '/api/download-clients', '/api/blocklist'];

function isForbidden(value) {
  return typeof value === 'string' && FORBIDDEN_PREFIXES.some((p) => value === p || value.startsWith(`${p}/`));
}

/** Flags any string or template-literal segment naming one of the plugin's
 *  routes — the fence for the "core references no plugin" rule. */
const noPluginApiPaths = {
  create(context) {
    const report = (node, value) =>
      context.report({
        node,
        message: `"${value}" names the acquisition plugin's routes — core must not reference them directly. Allowlist the file in eslint.config.mjs if it still legitimately needs this.`,
      });
    return {
      Literal(node) {
        if (isForbidden(node.value)) report(node, node.value);
      },
      TemplateElement(node) {
        if (isForbidden(node.value.raw)) report(node, node.value.raw);
      },
    };
  },
};

export default [
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      sourceType: 'module',
    },
    plugins: {
      fence: { rules: { 'no-plugin-api-paths': noPluginApiPaths } },
      // Not enabled — registered only so pre-existing `// eslint-disable
      // @typescript-eslint/no-explicit-any` comments resolve instead of
      // erroring as an unknown rule now that this is the first config to lint them.
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      'fence/no-plugin-api-paths': 'error',
      '@typescript-eslint/no-explicit-any': 'off',
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
  },
];
