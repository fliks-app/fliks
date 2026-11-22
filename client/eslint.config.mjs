// @ts-check
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import angular from 'angular-eslint';

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

/** Files that parse or report the UA string; everything else reads DeviceService or `detectDevice()`. */
const USER_AGENT_READERS = [
  'src/app/core/services/device.service.ts',
  'src/app/core/utils/ua-parser.ts',
  'src/app/core/utils/device-info.ts',
  'src/app/core/services/system-info.service.ts',
  'src/app/core/services/webos-capabilities.ts',
  'src/app/core/services/browser-device-profile.service.ts',
  'src/app/core/services/push.service.ts',
  'src/app/core/services/sse.service.ts',
  'src/app/features/player/player.ts',
];

const NAVIGATOR_USER_AGENT = {
  selector: "MemberExpression[object.name='navigator'][property.name='userAgent']",
  message: 'Platform facts come from DeviceService or detectDevice() (core/services/device.service.ts), not a UA sniff at the call site.',
};

/** A native `<dialog>` announces as "dialog" unless it carries a name. */
function holdsModalHeader(node) {
  const seen = new Set();
  const walk = (n) => {
    if (!n || typeof n !== 'object' || seen.has(n)) return false;
    seen.add(n);
    if (n.name === 'app-modal-header') return true;
    return ['children', 'branches', 'cases', 'empty', 'pending', 'error', 'placeholder', 'loading'].some((k) =>
      Array.isArray(n[k]) ? n[k].some(walk) : walk(n[k]),
    );
  };
  return (node.children ?? []).some(walk);
}

const dialogName = {
  create(context) {
    return {
      'Element[name="dialog"]'(node) {
        const names = [...node.attributes, ...node.inputs].map((a) => a.name);
        // `<app-modal-header>` names its enclosing dialog by its title.
        if (!names.some((n) => /^(attr\.)?aria-label(ledby)?$/.test(n)) && !holdsModalHeader(node)) {
          context.report({ node, message: '<dialog> needs aria-label or aria-labelledby.' });
        }
      },
    };
  },
};

const RESTRICTED_SYNTAX = [
        ...[
          'ConditionalExpression[test.left.value=/^(movie|series)$/]',
          'ConditionalExpression[test.right.value=/^(movie|series)$/]',
          'ConditionalExpression[test.left.right.value=/^(movie|series)$/]',
          'ConditionalExpression[test.right.right.value=/^(movie|series)$/]',
          'ConditionalExpression > Literal[value=/^.?(movie|series|movies|tv|add.tv|add.movie)$/]',
          'BinaryExpression[operator=/^[!=]==?$/] > Literal[value=/^.(movies|series)$/]',
        ].map((selector) => ({
          selector,
          message: 'Branch on a media kind through KIND_REGISTRY (core/media-kinds.ts), not a ternary on the literal.',
        })),
        NAVIGATOR_USER_AGENT,
        {
          selector: "Decorator[expression.callee.name='Component'] Property[key.name='changeDetection'][value.property.name='OnPush']",
          message: 'OnPush is the default: do not restate it.',
        },
        {
          selector: "Decorator[expression.callee.name=/^(Component|Directive|Pipe)$/] Property[key.name='standalone'][value.value=true]",
          message: 'standalone: true is the default: do not restate it.',
        }
];

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
      '@angular-eslint': angular.tsPlugin,
    },
    rules: {
      'fence/no-plugin-api-paths': 'error',
      '@angular-eslint/no-implicit-take-until-destroyed': 'error',
      '@typescript-eslint/no-explicit-any': 'off',
      'no-restricted-syntax': ['error', ...RESTRICTED_SYNTAX],
      'no-restricted-properties': [
        'error',
        { property: 'lastEvent', message: 'A signal coalesces frames: subscribe to SseService.events / on(...types).' },
      ],
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
  },
  {
    files: USER_AGENT_READERS,
    rules: {
      'no-restricted-syntax': ['error', ...RESTRICTED_SYNTAX.filter((r) => r !== NAVIGATOR_USER_AGENT)],
    },
  },
  {
    files: ['src/**/*.html'],
    languageOptions: { parser: angular.templateParser },
    plugins: { fence: { rules: { 'dialog-name': dialogName } } },
    rules: { 'fence/dialog-name': 'error' },
  },
  {
    files: ['src/**/*.spec.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
];
