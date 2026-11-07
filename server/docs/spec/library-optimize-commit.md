# Library optimizer: commit (server)

Module `server/crates/server/src/queue/` (`commit.rs`, `swap.rs`, `recover.rs`, `trash.rs`, `words.rs`, `ocr.rs`).

1. A `staged` job is probed by the local engine before any lock (streams and duration match the worker's `result`).
2. Busy file: an engine session, a `download` resolve under 10 minutes ago, or `listening()`. The job stays `staged`, `notBefore` +5 min, no failure.
3. Under `ingest.media.lock(media)` and `folder_moves` (read): the source must still be the job's snapshot (path, size, mtime, `dev:ino`), else `skipped` (`stale`).
4. Journal: `state = committing`, `result.journal` holds the paths, the `dev:ino`/size of source and staged, the policy and the companions. Written before the disk is touched.
5. Swap (`swap::perform`, idempotent): the original gets a second name (`trash`: `<root>/.fliks-trash/<job>.bak`; `keep`: `<source>.orig`, kept if present; `delete`: none) by hard link, or by a move to `.fliks-opt-<job>.old` on a filesystem without links; then the staged is renamed onto the target (`MoveFileEx` replace with retries on Windows, `busy` if still locked).
6. Rows: the forced rescan path (`ingest::rescan::refresh_content`, `content_changed`, `timeline_preserved`): streamInfo, quality, size, mtime, probeVersion, crop and `timestampBreakSeconds` recomputed, `osdbHash` kept; `subtitle_files."sourceStreamIndex"` set to NULL for image tracks that are gone (OCR SRTs stay); the OCR SRTs added by the job are deleted with their row; embedded rows recreated; `media.file_changed` SSE; `POST /v1/revoke {mediaFileIds}`; sprite requeued. Then `done`, `result.trashPath` for `trash`.
7. Renaming (library `allowRename`): only wrong technical words and the extension change; companions (`<stem>.<tail>`) follow in the journaled swap and `subtitle_files."filePath"` is updated, `hashMatched` kept.
8. Recovery of `committing` jobs at boot, every minute (rows idle for 2 minutes) and after a backup restore: the swap is run again from the journal; if nothing moved the job is `skipped`.
9. Restore (`recover::restore`): only while the file is still the produced one (`dev:ino`); the original comes back, the optimized file takes its slot.
10. Trash purge: after `trashRetentionDays`, and oldest first below `trashMinFreeGb`; `result.trashPurgedAt` is written (the lease space check counts the rest).

## Control (S5)

11. Queueing builds the engine's `OptimizePlan` from the diff (`Diff::plan`): video settings (quality, software, `tooSlow`, `maxSoftwareHours`, `minSavingsPct` unless the crop alone justifies the re-encode), drops, tags, titles, defaults, playable audio (`encode`, `keepOriginal`), container, OCR subtitles (`extraSubtitles`, only for tracks whose OCR finished), `hvc1`, statistics tags. `Reorder`, `Flags` and a rename alone are not in the plan.
12. Selection capabilities come from the registered workers (`Shared::capabilities`): encodable codecs, AV1 hardware decode on a local device. No worker registered: nothing is encodable and the video is copied.
13. `POST /api/libraries/{id}/optimize/queue` runs one `select::analyze` pass and answers 202 `{files}`; the jobs are inserted in the background. `POST /api/optimize/jobs/{id}/restore` is `recover::restore`.
14. `GET /api/optimize/queue`: `paused`, `open` (time window), job counts per state, and the estimate: per level the jobs, playing seconds left and estimated seconds, `etaSeconds` (closed hours included) and `endsAt`; none while a level with jobs has no history. Speed = playing seconds over `encodedAt - startedAt` of the last 20 jobs per device and level, times the device's slots. The preview carries `estimateSeconds` per level from the same speeds.
15. `POST /api/optimize/queue/pause|resume` (`paused` in the settings: no new lease), `POST /api/optimize/jobs/priority {ids}` (queued jobs run first, in the order given), `POST /api/optimize/jobs/cancel {ids}`.
16. SSE: `optimize.job_progress {jobId, progress, paused}` on each heartbeat, `optimize.job_changed {jobId, state}` on a state change (3 s sweep), `optimize.queue_changed` on queueing, reordering, pause and restore. Notifications `optimize.completed`, `optimize.failed`, `health.corrupt` (once per file) go out from the same sweep.
17. `hello` carries `cpuWeight` (default 2) and `gpuPlaybackBeforePause` (integer, 0 never) from the settings, applied at the next hello. `PUT /v1/config` sends `worker: true`.
