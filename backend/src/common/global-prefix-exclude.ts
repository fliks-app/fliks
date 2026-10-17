/** Routes served outside the `/api` prefix; `main.ts` and `scripts/dump-routes.ts` share the list. */
export const GLOBAL_PREFIX_EXCLUDE = [
  'engine/resolve',
  'internal/bridge/{*path}',
];
