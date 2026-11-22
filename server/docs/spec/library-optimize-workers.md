# Library optimization: remote workers

A remote worker is the engine binary started with `--worker-url` (or `FLIKS_WORKER_URL`) and `FLIKS_WORKER_TOKEN`. It speaks the same protocol as the local engine (`fliks-engine/PROTOCOL.md`, "Worker protocol"); this page is what the server adds for it.

## Tokens

- Created in Settings > Optimization workers: `POST /api/optimize/workers/tokens` returns the `fkw_` secret once; only its SHA-256 is stored (`worker_tokens`).
- `PATCH /api/optimize/workers/tokens/{id}`: `name`, `enabled`, `pathAccess`, `pathMappings`. `DELETE` revokes. A disable, a revocation or a patch that changes `pathAccess` or `pathMappings` puts the token's leases back in the queue; a rename keeps them.
- `WorkerAuth` accepts the local `hostToken` or a live token and is the only guard of `/engine/workers/*` and `/engine/jobs/*`. A job is fenced by `workerId = t<tokenId>:<instance>`, so a token can never touch another token's lease.

## Karaoke separation

A worker's `hello.features` (the engine's, e.g. `karaoke-separate`, `onnx-cuda`) is kept with the instance. A queued `separate` job (`karaoke.md` rule 16) is leased only to an eligible token worker, on its `cpu` device (it counts against that device's `maxJobs`), as `{"type": "Separate", ...}` with `modelVersion`, `inputPath` or `inputUrl` and `inputToken`; there is no `stagedPath`. A worker that cannot get the model at that version fails it with the `model` class: the job goes back to the queue after 60 s without counting a failure, and that worker gets no more `separate` job until its next hello.

## Reaching the library

The admin sets, per token, how the worker reaches files (the worker never declares it):

| `pathAccess` | Lease | Output |
|---|---|---|
| `shared` | `inputPath` and `stagedPath` translated by `pathMappings` (longest `from` prefix wins); extra subtitle paths in the plan too | written by the worker on the shared folder; commit checks its size like a local output |
| `none` | `inputUrl` = `<public_url>/api/stream/{file}?download=1` and `inputToken` | uploaded to the server, see below |

Stems of a `separate` job are uploaded by every worker, `shared` ones included: the stem cache is not under the mappings.

`none` needs the `public_url` setting (the address the operator tells workers to download from, not the `Host` of the lease request); without it a remote worker is leased nothing. Verifications (`verify`), metadata edits and plans with extra subtitles (server paths) read or write by path: they are only leased to path-reading workers.

## Read grant (`inputUrl`)

The lease mints an `fkj_<job>.<attempt>.<file>.<mac>` credential, signed with a key derived from the server secret and bound to (job, attempt, media file); it stays valid across a server restart while the lease does. The main engine's resolver answers it for the `download` purpose of that file only, while the job is leased at that attempt, with `ttlS = min(60, remaining lease)`. The grant is dropped and `POST /v1/revoke { credential }` is sent when the lease ends: a 409, a result, an expiry, a hello that abandons it (swept at that hello), a token change. The queue's 15 s sweep catches the rest.

## Output upload (`PUT /engine/jobs/{id}/output`)

- The server stages beside the source, exactly as for a local worker (`.fliks-opt-<id>-<attempt>.tmp`); the path never leaves the server.
- Chunks of at most `uploadChunkBytes` (8 MiB). `Upload-Offset` must equal the bytes held, else `409` with `{ receivedBytes }`; the worker continues from it. The lease (`X-Fliks-Attempt`, `X-Fliks-Worker-Id`) is fenced like a heartbeat: a mismatch is a `409` without an ack.
- A chunk renews the lease in the fenced statement that checks it. An upload above twice the source size plus 64 MiB is refused with `413`. The file is cut to the bytes counted before each chunk, so a failed write leaves nothing behind.
- One lock per (job, attempt); SHA-256 is computed during reception. After a server restart the first chunk folds the existing file back into the hash.
- `result` compares `outSize` and `outSha256` with what was received; a mismatch is a `network` failure (retried).

## Stem upload (`PUT /engine/jobs/{id}/output?name=<vocals|instrumental|guide>`)

- Same headers, chunking, offset, `409` and ack rules as above, one independent upload per name; an unknown name is `400`. The fence adds `kind = 'separate'` when `name` is present and `kind = 'optimize'` when absent, so a mismatch is `409`. The cap per stem is twice the source size plus 64 MiB.
- Staged at `<cache>/karaoke/.uploads/<job>-<attempt>-<name>.part`; the queue cleanup removes the files whose attempt no longer holds a lease.
- `result` carries `separate` (`model`, `modelVersion`, `provider`, `durationSeconds`, `stems[]` of `{name, size, sha256}`) with `outSize` 0; each stem is checked against its upload, a missing or mismatched one is a `network` failure (retried). A good result is committed by the server and deletes the job row (`karaoke.md` rule 16).

## Network and deployment

- A worker outside the LAN must use an `https://` `--worker-url`: the token and every output travel in it.
- Behind nginx, set `client_max_body_size` above 8 MiB (default 1 MiB answers every chunk `413`, a `network` failure).

## Windows and macOS workers

The released engine binary is the worker; no installer change. Set `FLIKS_WORKER_URL` (https, the server's public URL), `FLIKS_WORKER_TOKEN` (the `fkw_` secret) and `FLIKS_TRANSCODE_DIR` (a folder with room for one output per job). With `pathAccess: shared`, add the mappings in the Workers screen.

- Windows: run `fliks-engine.exe` as a service, e.g. NSSM: `nssm install FliksWorker C:\fliks\fliks-engine.exe`, then `nssm set FliksWorker AppEnvironmentExtra FLIKS_WORKER_URL=... FLIKS_WORKER_TOKEN=... FLIKS_TRANSCODE_DIR=D:\fliks-work`.
- macOS: a launchd agent in `~/Library/LaunchAgents/app.fliks.worker.plist` with `ProgramArguments` (the binary), `EnvironmentVariables` (the three variables), `RunAtLoad` and `KeepAlive` true; load it with `launchctl bootstrap gui/$UID <plist>`.

## Workers list

`GET /api/optimize/workers` rows carry `karaoke`, true when the instance takes `separate` jobs now (`karaoke.md` rule 16). The queue pause and schedule window apply to `separate` jobs like any other.
