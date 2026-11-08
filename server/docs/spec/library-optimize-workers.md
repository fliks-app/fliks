# Library optimization: remote workers

A remote worker is the engine binary started with `--worker-url` (or `FLIKS_WORKER_URL`) and `FLIKS_WORKER_TOKEN`. It speaks the same protocol as the local engine (`fliks-engine/PROTOCOL.md`, "Worker protocol"); this page is what the server adds for it.

## Tokens

- Created in Settings > Optimization workers: `POST /api/optimize/workers/tokens` returns the `fkw_` secret once; only its SHA-256 is stored (`worker_tokens`).
- `PATCH /api/optimize/workers/tokens/{id}`: `name`, `enabled`, `pathAccess`, `pathMappings`. `DELETE` revokes. A patch, a disable or a revocation puts the token's leases back in the queue.
- `WorkerAuth` accepts the local `hostToken` or a live token and is the only guard of `/engine/workers/*` and `/engine/jobs/*`. A job is fenced by `workerId = t<tokenId>:<instance>`, so a token can never touch another token's lease.

## Reaching the library

The admin sets, per token, how the worker reaches files (the worker never declares it):

| `pathAccess` | Lease | Output |
|---|---|---|
| `shared` | `inputPath` and `stagedPath` translated by `pathMappings` (longest `from` prefix wins); extra subtitle paths in the plan too | written by the worker on the shared folder; commit checks its size like a local output |
| `none` | `inputUrl` = `<public_url>/api/stream/{file}?download=1` and `inputToken` | uploaded to the server, see below |

`none` needs the `public_url` setting; without it a remote worker is leased nothing. Verifications (`verify`) read the file by path and are only leased to path-reading workers.

## Read grant (`inputUrl`)

The lease mints an opaque `fkj_` credential bound to (job, attempt, media file). The main engine's resolver answers it for the `download` purpose of that file only, while the job is leased at that attempt, with `ttlS = min(60, remaining lease)`. The grant is dropped and `POST /v1/revoke { credential }` is sent when the lease ends: a 409, a result, an expiry, a hello that abandons it, a token change. The queue's 15 s sweep catches the rest.

## Output upload (`PUT /engine/jobs/{id}/output`)

- The server stages beside the source, exactly as for a local worker (`.fliks-opt-<id>-<attempt>.tmp`); the path never leaves the server.
- Chunks of at most `uploadChunkBytes` (8 MiB). `Upload-Offset` must equal the bytes held, else `409` with `{ receivedBytes }`; the worker continues from it. The lease (`X-Fliks-Attempt`, `X-Fliks-Worker-Id`) is fenced like a heartbeat: a mismatch is a `409` without an ack.
- One lock per job; SHA-256 is computed during reception. After a server restart the first chunk folds the existing file back into the hash.
- `result` compares `outSize` and `outSha256` with what was received; a mismatch is a `network` failure (retried).
