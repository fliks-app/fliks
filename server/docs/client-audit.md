# Client impact audit: security fixes F1-F7

Read-only audit for phase-2 plan section 7.6. Paths are relative to the repo root; `C` = `client/src/app`, `A` = `appletv/Sources`.
Tizen, webOS, Android TV, Capacitor and Electron all run the Angular bundle with `IS_STANDALONE_BUNDLE` true
(`C/core/utils/standalone-bundle.ts:9-17`): Bearer header, no cookie auth, cross-origin to the user's server.
Only the web build uses the `fliks_access` cookie. `client/tizen` and `client/webos` are packaging scripts only.
Cast receiver, `macos/`, `windows/` never call F1-F7 endpoints (receiver has no `/api/` call; hosts only `GET /api` health
at `macos/Fliks/Services/NodeManager.swift:184`, `windows/Fliks.Tray/Services/NodeManager.cs:178`, any status < 500 passes).

## F1 POST /api/auth/register requires users.manage

| client | call site | credential/behaviour | impact | verdict |
|---|---|---|---|---|
| Angular web | `C/core/services/auth.service.ts:613-617` (`register()`) | no caller anywhere (grep `register(` in `C/`), no route in `C/app.routes.ts`, no template | no register screen exists | OK |
| Capacitor, Tizen, webOS, Electron | same bundle | same | none | OK |
| Apple TV | none (grep `auth/register` in `appletv/`) | n/a | none | OK |
| Cast receiver, desktop main, hosts | none | n/a | none | OK |

Admin user creation uses `POST /api/users` (`C/core/services/api/users-api.service.ts:100`), not register. The dead `register()` method is the only trace; it could be deleted (optional).

## F2 GET /api/users/:id self or users.manage

| client | call site | credential/behaviour | impact | verdict |
|---|---|---|---|---|
| Angular web + all bundles | `C/core/services/api/users-api.service.ts:103-105` `get(id)`; only caller `C/features/settings/users/user-detail/user-detail.ts:41` | route `admin/users/:id` guarded by `adminGuard` + `permissionGuard('users.manage')` (`C/app.routes.ts:381-390`); 403 caught by empty `catch` after `Promise.all` | admin-only caller always holds users.manage | OK |
| Angular profile pages | `C/core/services/api/social-api.service.ts:120` uses `/api/social/users/:id/profile` | separate endpoint, unchanged | none | OK |
| Angular self | `usersApi.update` (PUT, `library-prefs.service.ts:49`, `player-settings.ts:90,103`) | PUT not GET | not affected by F2 (if F2 also touches PUT, re-check) | OK |
| Apple TV | only `PUT /api/users/{id}` at `A/Core/Auth/AuthService.swift:124` | PUT, self | not a GET | OK |

## F3 /api/images/* requires a token (cookie, Bearer, ?token=, stream scope)

Image URL builders: Angular `resolveUrl` pipe (`C/core/pipes/resolve-url.pipe.ts:44-54`) and direct `serverConfig.resolveUrl` calls; Apple TV `ImageURL.build` (`A/Core/ImageURL.swift:11-19`).
`withLiveTvLogoToken` (`resolve-url.pipe.ts:27-31`, applied only when `isNative`, line 52) appends `?token=` for `/api/livetv/channels/` only, never for `/api/images/`.

| client | call site | credential/behaviour | impact | verdict |
|---|---|---|---|---|
| Angular web (same-origin) | `<img [src]="... \| resolveUrl">` / `cachedSrc` (`C/shared/directives/cached-src.directive.ts:30-33`, plain `setAttribute('src')`) | browser sends `fliks_access` cookie on same-origin img; service worker (`ngsw`) refetches same-origin with cookie | works while cookie alive (see F7) | OK |
| Angular web, pre-login picker | `C/features/select-user/select-user.html:30-41` -> `C/shared/components/user-avatar/user-avatar.ts:41-44`, avatars from `GET /api/auth/users-public` (`auth.service.ts:291`), path `/api/images/user/:id` | no session needed on that screen; cookie may be absent | 401 -> `failed` signal -> initials fallback (`user-avatar.ts:46-50`): cosmetic only | OK (cosmetic) |
| Capacitor iOS/Android | same pipe, `resolveUrl` prefixes server URL (`C/core/services/server-config.service.ts:139-146`); `fetch(url)` for disk cache at `C/core/services/image-cache.service.ts:123-128,134` | `<img>` and `fetch` cross-origin from `capacitor://`/`http://localhost`; login XHR has no `withCredentials` (`credentials.interceptor.ts:59-63`) and `CapacitorHttp` is not enabled (`client/capacitor.config.ts`), so no cookie is ever stored; no header on `<img>`; no `?token=` | every poster/backdrop/avatar 401s; offline cache prefetch (`download-manager.service.ts:532`) also 401s | BLOCKER |
| Tizen, webOS, Android TV | same bundle, `file://` origin, CSP `img-src *` (`client/tizen/config.xml:44`) | same as Capacitor: no cookie, no header, no query token | all artwork 401 | BLOCKER |
| Electron desktop | same bundle at `fliks://app`; CORS reflected in `desktop/src/main/cors.ts:17-32` | same: `isNative` true, no `withCredentials`, no cookie stored | all artwork 401 | BLOCKER |
| Apple TV | `A/Core/ImageCache.swift:29` `URLSession.shared.data(from: url)`; builders `A/Core/ImageURL.swift:11-19` (comment line 7-8 "No auth token needed" becomes false); callers `A/Design/Components.swift:11`, `A/Design/Backdrop.swift:30,114`, `A/Features/MediaDetail/MediaDetailView.swift:84`, `EpisodeDetailView.swift:81`, `A/Features/Onboarding/SelectUserView.swift:174`, `A/Features/Player/PlayerView.swift:396` | no Authorization header, no `?token=`. `APIClient` uses its own `URLSession(.default)` (`APIClient.swift:105`) and `URLSession.shared` shares `HTTPCookieStorage.shared`, so a `fliks_access` cookie from a password login MAY be replayed by accident; not reliable (pairing/`loginWithToken`, keychain-restored sessions never get one) | artwork 401 for sessions without the cookie; pre-login avatars (`SelectUserView`) always 401 -> `placeholder` | BLOCKER |
| Native now-playing artwork (iOS) | `client/ios/App/App/NowPlayingController.swift:131-137` | sends the player headers (Bearer) when host matches | OK | OK |
| Native notification/session artwork (Android) | `client/android/app/src/main/java/media/fliks/app/RemoteNotificationPlugin.java:26-30`, `NativePlayerPlugin.java:579` (`setArtworkUri`) | no header, no custom `BitmapLoader` (grep) | lock-screen/notification art 401 | CHANGE (fails with F3 unless URL carries token) |
| Remote notification art (all bundles) | `C/core/services/remote-notification.service.ts:49`, `C/features/player/player.ts:1579` | URL built without token | same as above | CHANGE |
| MediaSession artwork (web) | `C/features/player/player.ts:1059-1060` | browser fetch, cookie normally sent | OK on web; native bundles as BLOCKER above | OK |
| Cast sender -> device | `C/core/services/cast.service.ts:667-668` `new chrome.cast.Image(info.posterUrl)`, from `cast-player.service.ts:1052` | Chromecast / Google Home UI fetch the URL with no credentials | cast poster 401 (receiver itself loads no server image: `cast-receiver/index.html:22,32` only `fliks-icon.svg`) | BLOCKER (cosmetic, poster only) |

What each client already holds: Angular bundles `AuthService.playbackToken` (stream token else access token, `auth.service.ts:191-193`) and `ensureStreamToken()` (`:587-610`); precedent of `?token=` on non-header loads (HLS `streaming-api.service.ts:465`, SSE `sse.service.ts:296-299`, live-TV logos). Apple TV: `AuthService.ensureStreamToken()` (`A/Core/Auth/AuthService.swift:255-275`, 12 h TTL) and `TokenStore.accessToken`. Cast: `getCastInfo()` token (`auth.service.ts:257-263`).

## F4 /api/persons/* requires authentication

| client | call site | credential/behaviour | impact | verdict |
|---|---|---|---|---|
| Angular web + all bundles | `C/core/services/api/persons-api.service.ts:62,68,75` (search, detail, provider-credits); routes `persons`, `persons/:id` under `authGuard` (`C/app.routes.ts:62-65,88,155`) | cookie (web) / Bearer (bundles) via `credentialsInterceptor` | already authenticated | OK |
| Person profile images | `/api/images/person/:id` | see F3 | covered by F3 | see F3 |
| Apple TV, Cast, Electron main | no `/api/persons` call (grep) | n/a | none | OK |

## F5 secrets redacted in GET /api/settings and GET /api/engine/remote

Convention (`backend/src/common/utils/secret-fields.util.ts:9-47`): secret keys are deleted from the read response (no placeholder value) and listed in `secretsSet`; on write a blank/absent secret keeps the stored value, explicit `null` erases it. The `SECRET_MASK` (`C/shared/components/schema-form/schema-form.ts:15`) is an input `placeholder` only, never a value.
Already-compliant pages: notifications (`C/features/settings/notifications/notifications.ts:151-152`, tokenStored + keep/clear), subtitle/translation providers (`subtitle-providers.ts:297-299`), schema-form with `secretsSet` (`schema-form.ts:60-61,142-157`).

| client | call site | credential/behaviour | impact | verdict |
|---|---|---|---|---|
| Admin engine page | GET `C/core/services/api/engine-remote-api.service.ts:38`; `C/features/settings/engine/engine.ts:46` `token.set(cfg.token)`; PUT `engine.ts:73-77`; test `engine.ts:93-97` | token loaded into the input as a clear value and always sent back on PUT and `/engine/remote/test` | redacted GET -> token absent -> `token.set(undefined)`; PUT sends blank/undefined (keeps stored value only if the Rust handler applies merge); `test` with blank token has no stored-secret resolution unless the Rust handler adds it (cf. `resolveStoredSecrets`, `secret-fields.util.ts:49-66`); no way to see "set" state or to clear (`null`) | CHANGE |
| Admin data-imports page | GET all `C/features/settings/data-imports/data-imports.ts:232-239` (keys `seerr_api_key`, `radarr_api_key`, `sonarr_api_key`, lines 31-35); save `:302-305,377-380,414-417` via `setBulk`; tests send `apiKey` `:319,395,432` | api keys read in clear, trimmed, written back; test buttons and `canSubmit*` gates require non-empty key (`:295,357,366`) | redacted GET -> empty key -> test buttons disabled, save writes `''` (erases the key unless server treats blank as keep) | CHANGE |
| Plugin settings forms | GET all `C/features/plugin-view/plugin-view.ts:205-213`; `saveForm()` `:245-258` writes every editable key back (null -> `''`) | `app-schema-form` bound without `secretsSet` (`plugin-view.html:72`); `plugin.<id>.<key>` secret fields round-trip as value | redacted GET -> blank secret saved back as `''` | CHANGE (only if Rust redacts `plugin.*` secret keys) |
| Other `/api/settings` readers | `subtitle-providers.ts:203-209`, `settings/general`, `naming`, `streaming`, `live-tv-settings`, `plugin-settings.ts:55-58` | read non-secret keys (booleans, numbers, names) | none | OK |
| Apple TV, Cast, Electron | no `/api/settings` or `/api/engine/remote` call | n/a | none | OK |

Which keys the Rust side redacts (a generic settings key list does not exist yet; `PROTECTED_KEYS` in `backend/src/modules/settings/settings.service.ts:13-25` only lists `engine_token`) decides the exact set of pages to change.

## F6 refresh_tokens pruning

| client | call site | credential/behaviour | impact | verdict |
|---|---|---|---|---|
| all | no client reads `refresh_tokens` (DB table); clients only POST `/api/auth/refresh` and `/api/auth/logout` with their own token (`auth.service.ts:532`, `A/Core/Auth/AuthService.swift:206-209,286-287`) | pruning is for expired/revoked rows older than 30 days | an expired refresh token already fails 401 -> session dropped (`auth.service.ts:564-571`, `AuthService.swift:182-230`) | OK |

## F7 cookie Max-Age = access-token lifetime

Backend note (P3 audit): an unitless `JWT_EXPIRATION` goes to `jsonwebtoken` as milliseconds; cookie max-age falls back to 7 d. Clients assume nothing about the cookie lifetime.

| client | call site | credential/behaviour | impact | verdict |
|---|---|---|---|---|
| Angular web | `C/core/interceptors/credentials.interceptor.ts:61-97`: `withCredentials`; on 401 with a stored refresh token, single-flight `refreshAccessToken()` (`auth.service.ts:476-485`), body `refreshToken`, response re-sets the cookie, request replayed; session resume refreshes at start (`auth.service.ts:389`) | refresh keyed on 401, not on the cookie; refresh token is persisted by the client, not cookie | cookie gone after 1 h -> API 401 -> refresh -> new cookie. Before, the 7 d cookie held a JWT already expired after 1 h, so the same 401 occurred. No timer, no silent refresh | OK |
| Angular web, EventSource and `<img>` | `C/core/services/sse.service.ts:296-312` (web: no token, same-origin cookie); images (F3) | neither goes through the interceptor, so no 401 -> refresh; they depend on a cookie renewed by some other API call | same as before for SSE (expired JWT = 401); after F3, images also lose the cookie after 1 h until the next API call renews it | OK (note) |
| Capacitor, Tizen, webOS, Electron | Bearer header, same interceptor (`credentials.interceptor.ts:55-63`); SSE pre-refreshes when `accessTokenExpired()` (`sse.service.ts:296-299`); `?token=` for HLS | cookie unused | none | OK |
| Apple TV | `A/Core/API/APIClient.swift:190` Bearer, `:207-209` 401 -> `refreshOnce()` + one replay, `AuthService.swift:182-230`; stream token 12 h refetched under 30 min | cookie unused except the accidental image replay (F3) | none | OK |
| Cast receiver | uses the `cast-info` token from the sender, no cookie | none | none | OK |

## Blockers and decisions needed

- F3 cannot be enforced as specified: no client except the same-origin web build sends a credential on `/api/images/*`. Affected, with what each already holds:
  - Capacitor iOS/Android, Tizen, webOS, Android TV, Electron: Angular bundle, `<img src>`/`fetch` cross-origin, no cookie (login XHR has no `withCredentials`), no header; holds `playbackToken` / `ensureStreamToken()`.
  - Apple TV: `URLSession.shared` with no header or query; holds `ensureStreamToken()` and `TokenStore.accessToken`. Any cookie replay is incidental and absent for pairing and keychain-restored sessions.
  - Cast: poster URL passed as `chrome.cast.Image` metadata, fetched by the Chromecast/Google Home UI without credentials; sender holds the `cast-info` token.
  - Android notification/session artwork and `RemoteNotification` artwork: `setArtworkUri(...)` with no header.
  - Pre-login user picker avatars (`/api/auth/users-public` then `/api/images/user/:id`) on every client: no credential exists before login. Web and Apple TV degrade to initials; the rule "any valid token" excludes them by definition.
- F5: which keys the Rust side redacts (engine token, `seerr/radarr/sonarr_api_key`, `plugin.<id>.<secret>`) and whether the generic `PUT /api/settings` and `PUT /api/engine/remote` and `POST /api/engine/remote/test` apply the keep-on-blank / `null`-clears convention; the three pages above send blank back otherwise.
- F2: confirm the rule covers GET only; PUT `/api/users/:id` is called for self (`library-prefs`, `player-settings`, Apple TV hidden libraries).

## Client changes needed

Dependent on the decisions above (none applied):

- F3 (only after the user's decision): image URL builders `C/core/pipes/resolve-url.pipe.ts` (extend token append to `/api/images/`), `C/core/services/image-cache.service.ts` (fetch URL), `C/core/services/download-manager.service.ts:532`, `C/core/services/remote-notification.service.ts:49`, `C/features/player/player.ts:1579`, `C/core/services/cast-player.service.ts:1052` / `cast.service.ts:667`; `A/Core/ImageURL.swift` (and stale comment lines 7-8); `appletv` callers listed in the F3 table; Android artwork in `RemoteNotificationPlugin.java` / `NativePlayerPlugin.java`.
- F5: `C/features/settings/engine/engine.ts` + `engine.html` (stored indicator, keep/clear, no token prefill), `C/core/services/api/engine-remote-api.service.ts` (type `token?` + `secretsSet`), `C/features/settings/data-imports/data-imports.ts` + template (same pattern, gates on `*Stored`), `C/features/plugin-view/plugin-view.ts` + `plugin-view.html` (pass `secretsSet`, skip blank secrets on save).
- F1 (optional cleanup): delete unused `register()` at `C/core/services/auth.service.ts:613-617`.
- F2, F4, F6, F7: no client change.
