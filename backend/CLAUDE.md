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
