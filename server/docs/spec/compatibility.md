# Spec: client compatibility window (`X-Fliks-Client`)

What a released client may rely on, and when the server may retire a route or a field. Implementation: `crates/server/src/http/client.rs` (the header), `auth/db.rs` (the session column), `.github/scripts/route-retention.sh` and `.github/scripts/client-route-gates.sh` (CI checks).

## Rules

1. The window is the current minor release and the previous one, for every client (web, Android, iOS, desktop, tvOS, webOS, Tizen, macOS). A sideloaded webOS bundle gets the same window and the existing update notice. A server serves the clients of its own window; a client keeps working against the servers of its window and gates newer routes on `SERVER_SINCE`.
2. A client sends `X-Fliks-Client: <platform>/<version>` (for example `ios/7.1.0`) on every request. The server keeps the first 64 characters, trimmed, and stores it on the session (`sessions.client`) next to `userAgent`, renewing it on each refresh, so an admin sees which devices run a build that leaves the window. A request without the header stores nothing: an older client, an OPDS, Kobo or kosync reader, a script.
3. The server never branches on this header. What a client can render stays declared by `X-Fliks-Kinds` (`client-kinds.md`) and what a server offers stays discoverable by version (`SERVER_SINCE`).
4. A route or field an in-window client calls or reads is removed only by a PR carrying the `wire-break` label and a line in `server/wire-breaks.txt` (`route-retention.sh`). A route no in-window client calls goes at once: the legacy TMDB detail routes `GET /api/metadata/movie/{tmdbId}`, `/tv/{tmdbId}` and `/tv/{tmdbId}/seasons` were deleted on this rule (no client of the window calls them; the window excludes every build before 6.0).
5. Every `/api` URL a client of `client/src` builds, and that the oldest release of the window does not serve, sits in a file that reads `SERVER_SINCE` (`client-route-gates.sh`, with an allowlist for URLs the script cannot resolve).

## Retirements waiting for the window to move

- `movies` and `series` of `GET /api/system/stats`: the 7.0 and 7.1 apps read them. They go once no release of the window does.
- The unbound mint of `POST /api/auth/cast-info` and `POST /api/auth/stream-token` (no `mediaFileId`): goes once the tvOS release that binds its token is out and the previous minor.
- Session tokens in `?token=` on the engine data plane: the same release.
