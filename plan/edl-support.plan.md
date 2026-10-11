# EDL support (`.edl` sidecars): cut, commercial skip, mute on every client

Issue #1575. Implementation-ready design.

## 0. Decisions

| Topic | Decision |
|---|---|
| Storage | **No DB storage.** The sidecar `<videoBase>.edl` is the source of truth, read and parsed at playback-info time with an in-memory cache keyed by `(path, mtimeMs, size)`. No migration for ranges, no rescan/rename/removal sync. |
| Timeline | EDL seconds count from the container start (`formatStart`), like Kodi and the repo's sidecar subtitles. playback-info maps them onto the client clock of the chosen play method: HLS `+ (formatStart - origin)`, DirectPlay unchanged. |
| Wire shape | `edl?: EdlRange[]` on playback-info (`{start, end, action: 'cut'\|'mute'\|'commercial'}`), sorted, non-overlapping, already on the response's timeline. Omitted when no file or the user disabled the feature. |
| Skip policy | One spec (§3). TS reference `core/utils/edl-policy.ts`; ports in `cast-receiver/edl.js` and `appletv/.../EdlPolicy.swift`. Skips driven in JS by boundary timers extrapolated from the last position tick. |
| Mute | Native/precise on every engine, separate from the user's mute (new `PlaybackEngine.setMuteRanges`). |
| Setting | Per-user server column `users.edlEnabled` (default `true`); the server omits `edl` when false. |
| Comskip `.txt` | Not supported: ambiguous extension and every known producer can write `.edl`. |
| Scene markers (2) | Parsed (validation) and dropped. Deferred. |
| Companion `.edl` | Added to the backend default list and the client default string; a migration appends `.edl` to an already-stored `companion_file_extensions` row. |

## 1. Backend

### 1.1 Why no DB
Everything that needs ranges goes through `POST /stream/:id/playback-info` (local player, cast `cast-player.service.ts dispatchLoad`, tvOS, offline downloads `download-manager.service.ts` ~L288); the desktop "original" download gets a small GET (§2.3). `resolveFile` already gives `resolved.absolutePath` and `resolved.mediaFile.streamInfo` (fps for `#frame`). One `fs.stat` per playback-info is negligible. Reading at play time makes add/remove/rename/edit always correct with zero sync code.

### 1.2 Files (new)
- `backend/src/modules/streaming/edl/edl-parser.ts` (pure) + `edl-parser.spec.ts`
- `backend/src/modules/streaming/edl/edl-sidecar.ts` (disk read, cache, logging, timeline mapping; module functions with a module `Logger`, same pattern as `transcoding/source-timeline.ts`; no Nest provider) + `edl-sidecar.spec.ts`

### 1.3 Parser (`parseEdl`)
```ts
export type EdlAction = 'cut' | 'mute' | 'commercial';
export interface EdlRange { start: number; end: number; action: EdlAction }
export interface EdlParseResult {
  ranges: EdlRange[];                                // sorted by start
  rejected: { line: number; reason: string }[];
  sceneMarkers: number;
}
export function parseEdl(text: string, fps?: number): EdlParseResult;
```
Kodi `EdlFileParser::Parse` + `CEdl::AddEdit` compatible (MPlayer is a subset):
1. Strip a leading BOM. Split on `/\r\n|\r|\n/`. Line numbers 1-based.
2. Trim. Skip empty lines and lines starting with `##` (a single `#` is a frame number).
3. Tokenize on `/\s+/` (spaces and Comskip TABs). 3+ tokens: `start end action` (extras ignored). Exactly 2: `T action`, a scene marker if action is 2, else rejected. Otherwise rejected `fields`.
4. Action `/^\d+$/`: 0 cut, 1 mute, 2 scene (count, drop), 3 commercial; else rejected `action`.
5. Time token: contains `:` → `/^(?:(\d+):)?(\d+):(\d+)(?:\.(\d+))?$/` (fraction padded/truncated to 3 digits); `#N` → `N / fps` when `fps > 0`, else reject this line only; otherwise `/^\d+(?:\.\d+)?$/` (no `,`, no sign); else rejected `time`. Round to ms.
6. Validate in file order: `start >= end` rejected `order`; overlap with an accepted range (`a.start < b.end && b.start < a.end`, any action) rejected `overlap`; touching allowed.
7. `MAX_RANGES = 10000`; beyond → rejected `limit`.
8. Return ranges sorted by start.

`fps` = `parseSourceFps(streamInfo.video[0].frameRate)` (already used in `streaming.controller.ts`).

### 1.4 Sidecar (`edl-sidecar.ts`)
```ts
export function edlPathFor(absVideoPath: string): string;  // dirname + basename-without-ext + '.edl'
export async function readEdlSidecar(absVideoPath: string, fps?: number): Promise<EdlRange[] | null>;
export function toPlaybackTimeline(ranges: EdlRange[], timeline: SourceTimeline, playMethod: PlayMethod): EdlRange[];
```
- `readEdlSidecar`: `fs.stat`; ENOENT or not a regular file → null. `size > 1 MiB` → warn once, null. Cache `Map<path,{mtimeMs,size,ranges}>`, cleared at 1000 entries. Rejects → one warning per `(path, mtimeMs)` listing the first 5 (`line 3: overlap`). Success → debug log counts. Other read errors → warn, null; never fail playback-info.
- `toPlaybackTimeline`: `shift = playMethod === 'DirectPlay' ? 0 : timeline.formatStart - timeline.origin`; `{start: max(0, start+shift), end: end+shift}`; drop `end <= 0` or `end <= start`.

### 1.5 Timeline rationale
HLS served timeline starts at the first presented frame (`servedOrigin`, `segment-packaging.service.ts anchorSegmentTimeline`); every HLS player puts playlist time 0 at the first segment, so client `currentTime` = content seconds (pts − origin), the convention `inputSeekSeconds` already uses. An EDL counts from the container start (Kodi rebases on `format.start_time`; the repo maps sidecar subtitles the same way via `cueOffsetSeconds`). Hence HLS time = `edl + formatStart - origin`. DirectPlay engines rebase on the container start, so shift 0. A play-method change mid-session always goes through `adoptPlaybackInfo`, whose response carries ranges on its own timeline.
Out of scope, report only: intro/outro markers are sent raw and are late on HLS by `origin - formatStart`.

### 1.6 playback-info and API
`streaming.controller.ts playbackInfo`, after `response` and `timeline` are known:
```ts
const edlRaw = user.edlEnabled === false ? null : await readEdlSidecar(resolved.absolutePath, sourceFps);
const edl = edlRaw?.length ? toPlaybackTimeline(edlRaw, timeline, response.playMethod) : undefined;
```
Add `edl` to the returned object. New route `@Get(':mediaFileId/edl')` → `{ ranges: EdlRange[] }` on the DirectPlay timeline, `[]` when disabled/absent, same guards as playback-info (consumer: desktop original download). `dto/playback-info.dto.ts`: `edl?: EdlRange[]`.

### 1.7 Per-user setting
- `users/entities/user.entity.ts`: `@Column({ default: true }) edlEnabled: boolean;`
- `users/dto/update-user.dto.ts`: `@IsOptional() @IsBoolean() edlEnabled?: boolean;`
- `users/users.service.ts` (next to `hideSpoilers`): apply it.
- Migration `backend/src/migrations/<next>-add-edl-support.ts`: up = `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "edlEnabled" boolean NOT NULL DEFAULT true` + append `,.edl` to an existing `companion_file_extensions` row unless already listed; down = drop the column.

### 1.8 Import, companions, delete
- `common/services/file-transfer.service.ts`: `DEFAULT_COMPANION_EXTS` += `.edl`. In `transferCompanions`, an exact stem match goes straight to `${newBaseName}${ext}` before the `langMatch` regex.
- `common/library-ingest/library-ingest.service.ts`: on `overwrite`, remove `<destDir>/<newBaseName>.edl` before `transferCompanions` (an EDL is tied to one encode). Never carried over.
- `media/media-service/media-mutation.service.ts deleteMediaFile` (deleteOnDisk): also unlink `edlPathFor(fullPath)`, ignoring ENOENT.
- Client `features/settings/general/general.ts` default string: append `,.edl`.

## 2. Client contracts

### 2.1 Types (`client/src/app/core/utils/edl-policy.ts`, W2)
```ts
export type EdlAction = 'cut' | 'mute' | 'commercial';
export interface EdlRange { start: number; end: number; action: EdlAction }
export interface TimeRange { start: number; end: number }
```
`streaming-api.service.ts PlaybackInfoResponse` gets `edl?: EdlRange[]` (W3).

### 2.2 Engine interface (`playback-engine.ts`, W2)
```ts
/** Silences audio inside `ranges` (content seconds, sorted, disjoint) on top of the user's
 *  `muted`/`volume`, which keep reporting the user's own state. Applies to the current load
 *  and every later load until replaced; [] clears. Safe before or after load(). */
setMuteRanges(ranges: readonly TimeRange[]): void;
```
`muted`/`volume` getters and `volumechange` reflect only the user's state; never report a gate mute.

### 2.3 Offline
`DownloadTask.offlineEdl?: EdlRange[]`; HLS path stores `playbackInfo.edl`; desktop original branch calls `streamingApi.getEdl(mediaFileId)` (`GET /stream/:id/edl`). Player offline branch feeds `offlineEdl` to the EDL controller.

### 2.4 Cast customData
`CastMediaInfo` gets `edl?: EdlRange[]; edlLabels?: { cut: string; commercial: string }` (translated by the sender), put into `customData`. `cast-player.service.ts dispatchLoad` takes `pi.edl` from its cast playback-info. iOS `CastPlugin.swift` must set `builder.customData` (W5).

## 3. Playback policy (single spec)
`t` content seconds on the engine clock, `D` duration. `EOF_SLACK = 0.05`, `COMMERCIAL_TAIL = 1.0`, `MUTE_MERGE_GAP = 0.2`. A session is one `mediaFileId`; reloads of the same file keep session state.
1. **Resolve(t)** (start position, every user seek target, every observed position): loop while a range contains `t` (`start <= t < end`) that is a `cut`, or a `commercial` not in `skipped` with `t < end - COMMERCIAL_TAIL`: add commercials to `skipped`, `t = end`. Then `t >= D - EOF_SLACK` → **end**; else changed → **seek(t)** + notice for the first skipped action; else none.
2. Cut: always skipped, including seeks/resume landing inside.
3. Commercial: skipped once per session; afterwards plays normally (seek back to watch).
4. Range at 0: Resolve on the start position; load directly at its end.
5. Range reaching EOF: **end** = natural end (local: pause + `state.ended.set(true)`; receiver: `playerManager.seek(D)`; tvOS: `onEnded()`).
6. Mute: silent iff `t` in a merged mute range (gaps ≤ `MUTE_MERGE_GAP` merged). Implementations may widen edges by ≤ 100 ms, never narrow. Correct across seek, pause, rate, reload. Never persisted, never touches user mute/volume.
7. Precision: mute edges ±100 ms; ≤ 250 ms of cut/commercial shown.
8. Scene markers: deferred.
9. Notice per skip: `player.edl.skipped_commercial` / `player.edl.skipped_cut`; a small badge `player.edl.muted` while in a mute range. No toast for mute.
10. Seekbar: bands per range (cut greyed, commercial distinct colour, mute thin strip). Timeline not compressed.

## 4. Per-platform mechanism
Skip (all JS engines): `EdlController` on every `timeUpdate` runs Resolve and arms one `setTimeout` to `policy.nextBoundary(t)` with delay `(boundary - tLast)/rate - (now - tickAt)`; on fire Resolve at the extrapolated position (`>= boundary - 0.03` counts as reached). Re-armed on timeUpdate, state change, rate change, seek; cleared while paused, pre-roll, casting, detached. Native engines emit an immediate timeUpdate on position discontinuities.

| Platform | Mute mechanism |
|---|---|
| Web (Shaka), webOS | `MuteGate` on the `<video>`: `video.muted = userMuted \|\| gated`, timer from `video.currentTime`, recomputed on seeking/seeked/play/pause/ratechange/timeupdate/loadedmetadata, lead 0.03 s. |
| Tizen (AVPlay) | `MuteGate` with `webapis.avplay.getCurrentTime()`, apply = `tizen.tvaudiocontrol.setMute`; privilege `http://tizen.org/privilege/tv.audio` in `client/tizen/config.xml`. Only engage if `isMute()` was false; release on range end, visibilitychange hidden, destroy, beforeunload; `localStorage['fliks.edlTvMute']` crash recovery. `TIZEN_MUTE_LEAD_S = 0.1`. Hardware gate first. |
| Android (ExoPlayer) | Plugin `setMuteRanges`; PCM sink (no passthrough) when ranges exist; one `PlayerMessage` per edge on the main looper, `applyGate()` = `player.setVolume(inMute(pos+0.02)?0f:1f)`, also on discontinuity, READY, load, setMuteRanges. |
| iOS (AVPlayer) | Plugin `setMuteRanges`; `addBoundaryTimeObserver` on all edges → `player.isMuted = inMute(t+0.02)`; also on seek, `timeJumped`, item replace. |
| tvOS | `PlayerView.swift`: boundary observer + `isMuted`; skips via `EdlPolicy.swift`. |
| Desktop (libmpv) | Main process sets `af=@fliksedl:lavfi=[volume=volume=0:enable='between(t,s1,e1)+…']` or removes it when empty. |
| Cast receiver | `cast-receiver/edl.js` port; reads `customData.edl`; `video.muted` on our own media element; skips via `playerManager.seek`; notice overlay with `edlLabels`. Spike: CAF with `setMediaElement`, passthrough. |

## 5. Workstreams (disjoint files)
- **W1 Backend**: `backend/src/modules/streaming/edl/*`, `streaming.controller.ts`, `dto/playback-info.dto.ts`, `users/entities/user.entity.ts`, `users/dto/update-user.dto.ts`, `users/users.service.ts`, the migration, `file-transfer.service.ts`, `library-ingest.service.ts`, `media-mutation.service.ts`, related specs.
- **W2 Client engines + pure helpers**: `core/utils/edl-policy.ts` (+spec), `core/services/playback-engine/mute-gate.ts` (+spec), `playback-engine.ts`, `shaka-engine.ts`, `webos-engine.ts`, `tizen-engine.ts`, `native-engine.ts`, `desktop-engine.ts`, `core/plugins/native-player.plugin.ts`, `core/plugins/desktop-player.bridge.ts`, `client/tizen/config.xml`.
- **W3 Client player/UI/API/offline/cast sender/i18n**: `features/player/edl-controller.ts` (+spec), `player.ts`, `player.html`, `controls/player-controls.*`, `shared/components/seekbar/*`, `streaming-api.service.ts`, `download-manager.service.ts`, `download-cache.service.ts`, `cast.service.ts`, `cast-player.service.ts`, `playback-settings/player-settings/*`, `auth.service.ts`, `users-api.service.ts`, `settings/general/general.ts`, `public/i18n/*.json`.
- **W4 Android**: `NativePlayerPlugin.java`.
- **W5 iOS**: `NativePlayerPlugin.swift`, `CastPlugin.swift`.
- **W6 Desktop main**: `desktop/src/shared/contract.ts`, `preload/index.ts`, `main/ipc.ts`, `main/index.ts`, `main/mpv/player-backend.ts`, `mpv-player.ts`, `mac-mpv-player.ts`, new `main/mpv/edl-filter.ts` (+test).
- **W7 Cast receiver**: `cast-receiver/receiver.js`, `index.html`, `receiver.css`, new `edl.js`.
- **W8 tvOS**: `Models.swift`, new `EdlPolicy.swift`, `PlayerView.swift`, `LocaleStore.swift`.

## 6. Reviewer verification
1. Backend jest specs for parser, sidecar, file-transfer, media-mutation; migration on a throwaway DB (column added, `.edl` appended once).
2. Fixture with `0 5 0`, `20 21 1`, `40 60 3`, `<D-10> <D+5> 0` on every client: starts at 5 s, silent 20-21 s, commercial skipped once with a notice and replayable, ends and auto-advances near EOF, seek to 2 s lands at 5 s.
3. MPEG-TS with `formatStart` ≠ first frame: mute edges line up on DirectPlay and HLS.
4. User mute independence (mute at 15 s stays muted after 21 s; unmute at 20.5 s still silent until 21 s; volume UI never shows the gate).
5. Reloads inside a mute range (quality switch, seekByReload, sid refresh): gate correct, commercial not re-skipped.
6. Cast hand-off both ways. 7. Offline. 8. Setting off: no `edl`. 9. Import rename/overwrite/delete. 10. Tizen crash recovery and user remote mute.
