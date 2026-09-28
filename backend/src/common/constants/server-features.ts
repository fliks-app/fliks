/** Capabilities this server build advertises on `/api/auth/me`. Additive
 *  only: never remove an entry a shipped client may already check for. */
export const SERVER_FEATURES = ['deviceProfileExtensions'] as const;
