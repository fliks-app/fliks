# Spec: device tokens

Scope: the credentials a device that cannot do a host login (an e-reader, an OPDS or sync app) presents: their table, routes, hashing, scope, and how `POST /engine/resolve` accepts them (`engine-glue.md` section F). The OPDS catalogue (plan 4.3) and kosync (4.4) read these rows and are specified with their own routes; so does the Kobo sync (6.1, `kobo.md`). The engine side is `PROTOCOL.md` "Device credentials" (`device-credentials` feature, `credentialSource`).

## Data

1. `device_tokens("id" serial, "userId" -> users ON DELETE CASCADE, name text, kind device_token_kind, "hash" text UNIQUE, "createdAt", "lastUsedAt" NULL)`; `device_token_kind` is the enum `opds | kosync | kobo | subsonic`, extended with `ALTER TYPE ... ADD VALUE`. `IDX_device_tokens_userId` serves the cascade and the list.
2. A token is `fkd_` + 64 lowercase hex characters (32 bytes of OS randomness), shown once, in the answer of its creation or renewal. Only a hash is stored, never the token. **Exception: `subsonic`** (rule 15).
3. The hash is `hex(sha256(secret))`, where `secret` is the token for `opds` and `kobo` and the lowercase hex MD5 of the token for `kosync`: a kosync client sends `x-auth-key` = MD5(password), and the password a user types is the token. So the kosync row can be found from `x-auth-key` alone, and a kosync token presented as itself never matches (rule 9).
4. A user holds at most 20 tokens: the 21st creation is `400 device_tokens.error_too_many`.

## Routes

Every route requires a session credential (`remote.md` rule on `SessionAuthed`): a scoped token is `403 session_token_required`, and a device token never manages tokens. Every row is the caller's own: another user's id is `404 device_tokens.error_unknown`.

| Method path | Request | Response | Errors | Side effects |
|---|---|---|---|---|
| `GET /api/device-tokens` | none | `DeviceToken[]`, oldest first | 401, 403 | none |
| `POST /api/device-tokens` | `{ name: string, 1..80 characters after trim, kind: 'opds' \| 'kosync' }`, unknown keys 400 | 201, `DeviceToken` + `token` | 400 validation, 400 `device_tokens.error_too_many` | INSERT |
| `POST /api/device-tokens/:id/renew` | none | 201, `DeviceToken` + `token` | 404 `device_tokens.error_unknown` | UPDATE `hash`, clears `lastUsedAt` |
| `DELETE /api/device-tokens/:id` | none | 204 | 404 `device_tokens.error_unknown` | DELETE |

`DeviceToken { id, name, kind, createdAt, lastUsedAt: ISO-8601 with ms | null }`; the hash is never serialised.

5. Revoking or renewing takes effect in the database at once. The engine caches answers per credential and the plaintext is not kept, so `POST /v1/revoke { credential }` cannot be used, and `revokeOwner` would end the owner's playback sessions: the 30 s `ttlS` of an allow (rule 8) is the documented bound of a revocation.
6. A token of a disabled user, or of a deleted one (cascade), resolves to nothing.

## Resolving

7. `POST /engine/resolve` tries the credential as a JWT first (unchanged), except when `credentialSource` is `basic`. When no JWT user comes out, it looks for a device token: the secret is the password of a `Basic` credential (`base64(identifier:password)`, the identifier is free and ignored, the password is everything after the first `:`), else (`bearer`, `query`, `path`, `cookie`) the token as for JWTs. An absent `credentialSource` is a denial.
8. An allow for a device token carries `ttlS` 30 (a JWT allow keeps 60; denials keep 60): the engine caches answers per credential, so a short TTL bounds the delay of a revocation.
9. Scope by kind, each kind naming the credential sources it accepts: `opds` accepts `basic` only; `kosync` accepts none (its tokens never open the data plane); `subsonic` accepts none (its token and its salted forms are read by `/rest` only, `opensubsonic.md` rules 7-8); the data plane is opened by the stream credential of rule 16, not by the token. `kobo` accepts `path` only (the download links of the device carry the token as `/cred/<token>/api/stream/<id>?download=1`). A source outside the kind's list is a denial, so a token that travelled in a URL (`query`, `path`) or in a cookie never opens an `opds` row, and a Basic or Bearer value never opens a `kobo` one. A device token resolves the file purposes its kind lists, never `live` (it names no owner): `opds` all four of `stream`, `download`, `sprite` and `subtitle`; `kobo` `download` only, and only for a file that is the part of an item of a `text` edition (`Kind::opens`, then the text check of `engine/resolve.rs`), so a Kobo token in a URL never streams video or audio.
10. The answer then goes through the same checks as a user's: the library ACL (`check_library`) and the edition rule (`libraries::HIDDEN_FILES_FROM` through `assert_file_accessible`, `engine-glue.md` rule 41), on every answer, with the token's owner as the caller. A token never reads more than its owner does.
11. A hit sets `lastUsedAt = now()`.
12. A secret that is not shaped like a token (`fkd_` + 64 hex), an unreadable Basic value or an identifier over 255 bytes is a denial with no lookup.
13. There is no failure throttle on the resolver: the engine sends no client address, so a key could only be the client-chosen Basic identifier, which would let anyone lock a reader out; the 256-bit token is the protection. Routes that see the client (OPDS, kosync `/users/auth`) throttle on its network like the login (`auth.md` rule 39).

## The `subsonic` kind

14. A `subsonic` row is the app password of an OpenSubsonic client (`opensubsonic.md`): it is also the `apiKey`. Its `secret` is the token itself, the hash of rule 3 being `hex(sha256(token))` as for `opds`, so `p`, `p=enc:` and `apiKey` are found by hash.
15. **Exception to rule 2.** Token-and-salt authentication (`t = md5(password + s)`) can only be checked against the cleartext password, so a `subsonic` row also stores it, encrypted, in `device_tokens."secret"` (`bytea`, NULL for every other kind by `CK_device_tokens_secret`): `nonce (12 bytes) || ChaCha20-Poly1305 ciphertext`, the user id as associated data, the key `sha256("fliks-subsonic-secrets:" + jwt secret)`. Rotating the JWT secret leaves the rows unreadable for `t`; they still verify by hash, and the user renews the password. The secret is never serialised, logged, or read outside `/rest` authentication; renewal replaces it with the hash. A renewal replaces the hash and the secret in one statement.
16. A stream credential for a `subsonic` row is a stream token (`auth.md` rule 10) with the claims `dt` (the row id) and `ds` (the first 16 hex digits of its hash) and no session (`opensubsonic.md` rule 31). `POST /engine/resolve` accepts it as a JWT with the file bound by `mf`: the row must exist, be of kind `subsonic`, belong to `sub` and still carry the hash `ds` names (a renewal ends the credentials issued before it), and the owner be enabled, else a denial; it opens `stream` and `download` and nothing else, and answers with the device `ttlS` of rule 8. Deleting the row ends it within that TTL.
