# backend

NestJS API. Conventions that apply repo-wide live in the root `CLAUDE.md`.

## Streaming and transcoding are frozen

- Once M4 of the engine plan lands, `src/modules/streaming/` (decision, transcoding, HLS, remux) takes bug fixes only.
- Video work (decisions, ladders, HDR/DV, ffmpeg sessions, segment serving) goes to `github.com/fliks-app/engine`, not here.
- Until then a decision change here must also regenerate the vectors below, so the Rust port sees it.

## Decision vectors (`test/engine-vectors/`)

Golden inputs and outputs of `StreamBuilderService.evaluate()`, consumed by the engine's `core::decide`.

- Replays every `evaluate()` call of the audio-decision, dovi-play-method, direct-stream-guards, negotiated-quality, crop-local and hdr-local-tonemap specs, plus a synthetic device x media x host-caps matrix (`cases.ts`).
- Host capabilities (`host-caps.ts`) are injected by mocking the boot probes (encoder, decoder, tone-map, libfdk) and `process.platform`; `makeStreamBuilder({ hwAccel })` sets the detected backend.
- Output is deterministic: sorted keys, no timestamps, file name = slug of the vector name.

Regenerate (rewrites `fixtures/decide/*.json` in the engine checkout, deleting stale ones):

```
cd backend && FLIKS_ENGINE_REPO=/path/to/engine npx jest test/engine-vectors
```

Verify without writing:

```
FLIKS_ENGINE_REPO_CHECK=/path/to/engine npx jest test/engine-vectors
```

Differential fuzz for the engine's `decide_fuzz` test (seeded random inputs, NDJSON out): `FUZZ_OUT=<dir> FUZZ_SEED=<n> FUZZ_COUNT=<n> npx jest test/engine-vectors`.

Without any of these variables the spec skips. Then commit the fixtures in the engine repo and run its `cargo test`.

New decision inputs: add a case to `cases.ts` or a test in one of the replayed specs, never edit `expected` by hand.
Wire field names must match `crates/core/src/api.rs`: the engine's round-trip test fails otherwise.

## Probe vectors (`test/engine-vectors/probe-*.ts`)

Golden raw tool output and results of `FfprobeService.detectMediaFileInfo` + `detectCrop`, consumed by the engine's `core::probe` (`fixtures/probe/`).

- `probe-io.ts` stands in for `child_process` (and `stat`): the real service runs against recorded output, canned answers (`probe-synthetic.ts`, `probe-fuzz.ts`) or the real tools on a corpus (`tools/gen-probe-corpus.sh` in the engine repo). Crop runs in software (platform forced off Linux).
- Regenerate: `FLIKS_ENGINE_REPO=/path/to/engine PROBE_CORPUS_DIR=<corpus> PROBE_TOOLS=<bin dir with ffprobe, ffmpeg, mkvmerge> npx jest test/engine-vectors/probe-vectors`. Without the corpus variables the recorded corpus runs are kept and `expected` is recomputed by the service. Verify: `FLIKS_ENGINE_REPO_CHECK=/path/to/engine npx jest test/engine-vectors` (replays the recorded runs, no tools needed).
- A change to `ffprobe.service.ts`, `mkv-language-tags.ts` or `moviehash.ts` must regenerate them.
- Library differential (personal data, output never committed): `PATH=$(tools/probe-tools.sh):$PATH PROBE_LIBRARY=<dir> PROBE_OUT=<out.ndjson> npx jest test/engine-vectors/probe-vectors` writes `{path, info, moviehash, ms}` per video file; the engine's `probe_library` test replays it.

## Host capability vectors (`hw-vectors.spec.ts`)

Golden state of the boot detection (`TranscodingService.onModuleInit`, the probes, GPU enumeration, pause probe) for the engine's `core::hw`.

- Runs the real service against a mocked `child_process` and `fs`; each fixture in `fixtures/hw` stores what ffmpeg and sysfs answered (`calls`, `env`), `expected` is the TS state serialised as the engine's `Capabilities`/`HostCaps` plus the set of ffmpeg commands.
- `hw-scenarios.ts` scripts the synthetic hosts (nvenc, amf/win32, qsv/win32, videotoolbox/darwin, cpu-only, broken GPU, blacklisted ids). nvenc, win32 and darwin are synthetic only; the real ones are recorded on a machine with the GPUs.
- Generate/verify with `FLIKS_ENGINE_REPO` / `FLIKS_ENGINE_REPO_CHECK` as above; `FLIKS_HW_RECORD=<name>` re-records one real scenario here; `FLIKS_HW_LIVE=<out.json>` (+ `FLIKS_HW_NODE`) runs the detection for real and writes the state, for parity against the engine's `hw-detect`.
- A change to a probe's argv, timeout or conditions must regenerate these too.

## Session vectors (`session-vectors.spec.ts`)

Golden results of the real session services for the engine's `core::session` (`fixtures/session`): `TranscodingService.resolveExistingSession` and `cleanupStaleSessions`, the throttle predicates and `tickOnce`, `TranscodeCacheService.runGc`, `LiveSessionRegistry` gc/revive/cap, `SessionRouter.assertFresh`, variant keys.

- `session-vectors.ts` runs each kind against stubs of the services' private state (`session-cases.ts` holds the replays of the resolve-existing-session and ffmpeg-throttle specs, the cache and lifecycle TTL/LRU cases, the synthetic matrices and the seeded fuzz generators); inputs and `expected` are in the engine's wire shape.
- Generate/verify with `FLIKS_ENGINE_REPO` / `FLIKS_ENGINE_REPO_CHECK` as above; fuzz with `SESSION_FUZZ_OUT=<dir> SESSION_FUZZ_SEED=<n> SESSION_FUZZ_COUNT=<n>`; `SESSION_FUZZ_EXPECT=<dir>` recomputes a promoted vector.
- A change to the seek matrix, the throttle, the cache GC or the job/live-session lifetimes must regenerate them too.

## Argv vectors (`argv-vectors.spec.ts`)

Golden ffmpeg argv of `buildFfmpegArgs`, `buildRemuxArgs`, the encoder descriptors, `buildLiveFfmpegArgs` and `buildIFrameSegmentArgs`, consumed by the engine's `core::args` (`fixtures/argv/`).

- Records every builder call of the replayed argv specs (golden, encoders, live, iframe, timeline), plus a matrix built from the engine's `fixtures/decide` (Transcode as VOD runs on two hosts, DirectStream as remux runs) and a live matrix (`argv-cases.ts`).
- `expected` is always recomputed from the stored input under its `hostCaps` and `env` (render node pin, `FLIKS_OPENCL_DEVICE`); a throw is stored as `{ error }`.
- Generate/verify with `FLIKS_ENGINE_REPO` / `FLIKS_ENGINE_REPO_CHECK`. Fuzz: `ARGV_FUZZ_OUT=<dir> ARGV_FUZZ_SEED=<n> ARGV_FUZZ_COUNT=<n>` (NDJSON for the engine's `ARGV_FUZZ_DIR`); promote with `ARGV_FUZZ_EXPECT=<dir>`.
- A change to the argv builders, encoders, filter graph or `hw-device.ts` must regenerate these.

## Packaging vectors (`packaging-*.ts`)

One recorded call each of the playlist builders (master, media, routes) and the fMP4 packaging functions (`timeline.ts`, `cmaf-rewrite.ts`, `segment-boundaries.ts`, `source-timeline.ts`, `remuxRunStart`, the pure `remux-assembler.ts` helpers), for the engine's `core::hls` (`fixtures/hls`) and `core::mp4` (`fixtures/mp4`).

- Replays the master-playlist, controller, timeline, cmaf-rewrite, remux-assembler, segment-boundaries, source-timeline and output-timeline specs, wrapping the exports to record their calls, plus a synthetic matrix (`packaging-cases.ts`). Bytes are base64, bigints strings.
- Generate/verify with `FLIKS_ENGINE_REPO` / `FLIKS_ENGINE_REPO_CHECK` as above; `PACKAGING_FFMPEG=<ffmpeg>` re-records the `real-*` clip fixtures. Fuzz: `PACKAGING_FUZZ_OUT=<dir> PACKAGING_FUZZ_SEED=<n> PACKAGING_FUZZ_COUNT=<n> npx jest test/engine-vectors/packaging-vectors`.
- A change to those files (or to a playlist route) must regenerate these.

## Remux assembler vectors (`remux-vectors.spec.ts`)

Golden runs of `RemuxSegmentAssembler` for the engine's `core::mp4` (`fixtures/mp4/assembler`): `input` is the GOP files a remux run wrote (base64), `expected` the segments served from them plus the frontiers.

- Check derives the plan with `remuxAssemblyPlan` from the stored scan, grid and run, assembles the stored GOP files and compares; no ffmpeg needed.
- `FLIKS_ENGINE_REPO` alone recomputes `expected` of the stored runs. With `REMUX_TOOLS=<bin dir with ffmpeg, ffprobe>` it re-records them from freshly encoded clips, whose bytes follow the ffmpeg build: expect a diff on another version.
- A change to `remux-assembler.ts`, `segment-boundaries.ts` or the remux argv must regenerate them.

## Dolby Vision codecs and open report vectors (`dv-codecs-vectors.spec.ts`, `report-vectors.spec.ts`)

- `fixtures/hls/dv-codecs.json`: `dvSupplementalCodecs` / `dvStandaloneCodecs` over a DV field matrix.
- `fixtures/report/open-report.json`: what playback-info derives beside the decision (`playbackClockOffsetS`, `tonemapAlgo`/`tonemapCurve`, QoE pipeline) for every `fixtures/decide` vector, so regenerate `decide` first. The curve cycles over the vectors.
- Generate/verify with `FLIKS_ENGINE_REPO` / `FLIKS_ENGINE_REPO_CHECK`. A change to `dolby-vision.ts`, `encode-pipeline.ts`, `qoe-pipeline.ts` or `source-timeline.ts` must regenerate them.
