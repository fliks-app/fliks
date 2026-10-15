# Bridge registry

Temporary HTTP endpoints between `fliks-server` and Nest during the strangler. Each row is added in the milestone that needs it and removed when the bridge is deleted. Planned list: phase-2 plan §6.4.

Auth: `Authorization: Bearer $FLIKS_BRIDGE_TOKEN` (random per boot; constant-time compare). Nest serves bridges under `/internal` (no `api` prefix). Public fallback must 404 `/internal/**`.

| Endpoint | Direction | Payload | Added | Removed |
|---|---|---|---|---|
| `POST /internal/bridge/emit` (Nest) | S1 to S2 | `{event:"pairing.requested", userId:int, pairingId:string, deviceName:string, deviceId:string}`; delivered to `userId`'s connections only (F13); 204 | S1 | S2 |
| `POST /internal/bridge/drop-connections` (Nest) | S1 to S2 | `{userId:int>=1, targetId?:string}`; `targetId` = device-scoped logout drop, absent = account-wide (role change, enable/disable); 204 | S1 | S2 |
| `POST /internal/bridge/settings-changed` (Nest) | S1 to S9 | `{keys:string[] (non-empty), origin?:string}`; per key, in order: Nest's change listeners then the `settings.changed` domain event; `engine_url`/`engine_token` in `keys` also makes Nest re-adopt the engine; no DB write; 204 | S1 | S9 |
| `POST /internal/auth/stream-token` (Rust) | S1 to S7 | request `{userId:int}` (bearer bridge token; wrong bearer 401, bad body 400, unknown or disabled user 404), response 2xx JSON `{streamToken:string}`; Rust is the only signer: Nest live TV play calls it | S1 | S7 |

Nest bridge auth: missing `FLIKS_BRIDGE_TOKEN` answers 503 on every `/internal/bridge/*` call, a wrong or absent bearer 401. Nest reaches Rust through `FLIKS_SERVER_URL` (base URL, no trailing slash).

## Allowed duplication

- Users stats SQL (`UsersStatsService`) in Nest until S4 (social profile stats), duplicated by the Rust `GET /api/users/:id/stats`.
- Auth verify in Nest until S9: `jwt.strategy.ts`, guards, CASL factory, `PoliciesGuard`, `current-user` decorator, `jwt-secret.ts` (Nest still authenticates its own routes; Rust signs).
