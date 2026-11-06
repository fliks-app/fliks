# Spec: OpenID Connect providers

Provider administration for single sign-on (`auth.md` rules 68 to 85 hold the sign-in flow). Every route needs `Authed` with `isAdmin`: `settings.access` is grantable to a non-admin role and these rows decide who can become an admin, so a non-admin (any role) gets 403 `Forbidden resource`.

## Routes

| Method path | Request | Response | Errors |
|---|---|---|---|
| `GET /api/oidc-providers` | none | 200 `[Provider]` by `position`, `id` | 401, 403 |
| `POST /api/oidc-providers` | body `ProviderBody` | 201 `Provider` | 400 validation, provider without S256, discovery failure, `public_url` unset while `enabled`; 403 |
| `PUT /api/oidc-providers/:id` | body `ProviderBody` | 200 `Provider` | 400; 404; 409 (rule 7); 403 |
| `DELETE /api/oidc-providers/:id` | none | 204 | 404; 409 (rule 7); 403 |
| `POST /api/oidc-providers/test` | `{issuer, caPem?}` | 200 `{ok: true, issuer, algs: string[], pkce: bool, endSession: bool, backchannel: bool}` or `{ok: false, error}` (a kind, never a URL) | 400 body; 403 |

`Provider` = `{id, name, issuer, clientId, clientSecretSet: bool, caPem: string|null, scope, prompt: string|null, usernameClaim, groupsClaim: string|null, allowedGroups: string[], adminGroups: string[], roleMappings: [{group, roleId}], autoRegister, matchByEmail, endSessionAtProvider, accountUrl: string|null, enabled, position, linkedUsers: number}`. `ProviderBody` = the same without `id`, `clientSecretSet` and `linkedUsers`, plus `clientSecret?: string`; unknown keys 400.

## Rules

1. `name` 1 to 100 characters; `issuer` an `http(s)` URL without query or fragment, compared as the provider's discovery `issuer` byte for byte (no trailing-slash normalisation); `clientId` non-empty; `scope` defaults to `openid profile email` and must contain `openid`; `usernameClaim` defaults to `preferred_username`; `prompt` null or one of `none`, `login`, `consent`, `select_account`; `accountUrl` null or an `http(s)` URL; `caPem` null or a PEM bundle with at least one certificate. Blank strings are null. Violations are 400 with the list of messages.
2. `allowedGroups`, `adminGroups` and `roleMappings` need a `groupsClaim` (a dotted path such as `groups` or `realm_access.roles`); `roleMappings` groups are non-empty and unique, their order is their `position`, and a `roleId` that does not exist is 400.
3. `clientSecret` is never returned (`clientSecretSet` says whether one is stored). A blank or absent value on `PUT` keeps the stored one; a non-blank value replaces it. No `clientSecret` stores a public client.
4. `issuer` is immutable: it is the identity of every linked account, so `PUT` ignores it and a new issuer is a new provider.
5. `position` is taken as sent on `POST` and `PUT` (absent on `POST`: after the last, absent on `PUT`: unchanged). Several providers are listed by `position`.
6. Enabling (create with `enabled`, or `PUT` turning it on) needs `public_url` set (400) and a discovery document that lists `S256` in `code_challenge_methods_supported` (400; an IdP that ignores PKCE would redeem an intercepted code with any verifier). A `PUT` that leaves `enabled` unchanged does not contact the provider.
7. While `password_login` is `admins`, disabling or deleting the last enabled provider is 409.
8. Disabling a provider revokes its sessions; deleting it removes its identities, login rows and sessions by foreign keys. Both drop the users' SSE connections and flush the engine (`auth.md` rule 84). Any update or delete drops the provider's discovery and key caches.
9. `linkedUsers` counts `user_identities` rows of the provider.
10. The URIs registered at the provider are built from `public_url`: redirect `<public_url>/api/auth/oidc/<id>/callback` (one per provider, the mix-up defence of RFC 9700), back-channel logout `<public_url>/api/auth/oidc/<id>/backchannel-logout`, post-logout redirect `<public_url>/login?autoLaunch=0`.
11. `test` discovers without a stored provider: the same guarded fetch as sign-in (`auth.md` rule 79), no cache.
12. `DELETE /api/users/:id/oidc/:providerId` (`users.manage`; a non-admin caller cannot target an admin, as `PUT /api/users/:id`) removes one identity: 204, 404 when the user has none. It revokes no session.

## SQL

Tables `oidc_providers`, `oidc_role_mappings`, `user_identities`, `oidc_logins` and the `sessions` columns `providerId`, `subject`, `sid`, `idToken` are in the migration `1789000000800_oidc.sql`. `oidc_role_mappings` and `user_identities` cascade with their provider and their user.

## Vectors/parity

Integration tests in `server/crates/server/tests/it/oidc.rs` run against a fake provider (discovery, JWKS with an ES256 key, token with PKCE check, userinfo, end session). No parity scenario: the flow needs a provider.
