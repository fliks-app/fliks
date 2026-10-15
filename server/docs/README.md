# Server docs

## Spec index

Per-domain specs land under [`spec/`](spec/) as milestones complete (template: phase-2 plan §12). None yet.

## Tag legend (in specs)

| Tag | Meaning |
|---|---|
| `[ts:path:line]` | Open that file at that line only (±40 lines). |
| `[new]` | Deliberate deviation from Nest; record here or in Deviations. |
| `[assumed]` | Behaviour inferred where Nest is unclear; verify before port. |

## Deviations

Decided behaviour for the Rust port (security fixes, D3). Not implemented until the named milestone. Each has a parity exception.

| # | Today (Nest) | Rust behaviour | Client impact |
|---|---|---|---|
| F1 | `POST /api/auth/register` open to anyone | `register` requires `users.manage`, else 403. `admin/password` seed on empty users table stays | web register screen (hide for non-admins) |
| F2 | `GET /api/users/:id` readable by any user | self or `users.manage`; others 403 | user pages (social uses `/api/social/users/:id/profile`) |
| F3 | `/api/images/*` public | any valid token (cookie, Bearer, `?token=`, stream scope) | every client that loads `<img src=/api/images/...>` without a cookie (Apple TV, Tizen, webOS, Cast). If one cannot send a credential, stop and ask before enforcing. |
| F4 | `/api/persons/*` public | authenticated | none expected |
| F5 | `GET /api/settings` and `GET /api/engine/remote` return secrets in clear | secret keys redacted; PUT with placeholder keeps stored value | admin settings pages |
| F6 | `refresh_tokens` never pruned | daily prune of expired/revoked rows older than 30 days | none |
| F7 | access token 1 h but cookie `maxAge` default 7 d | cookie `Max-Age` = token lifetime | none |

Not done (user decision 2026-10-15): login rate limiting/lockout.

## Open divergences

None.
