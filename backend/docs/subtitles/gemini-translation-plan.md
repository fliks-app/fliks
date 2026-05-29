# Gemini integration plan — subtitle translation + monitoring

Reference document for implementing subtitle translation via the Gemini API in Fliks.

**Last updated:** 2026-05-29

---

## Product principles

### Fundamental difference vs OpenSubtitles

| | OpenSubtitles (and similar providers) | Gemini (translation) |
|---|--------------------------------------|----------------------|
| **Prerequisite** | Media metadata (title, year, hash…) | **An existing text subtitle file** on disk |
| **Action** | Search + external download | Read existing SRT/ASS → translate → **new** file |
| **Without a source subtitle** | Can still find a file | **Not possible** — nothing to translate |

Gemini **does not replace** automatic subtitle search. Expected user flow:

1. Obtain a subtitle (auto-download, manual search, disk import, Radarr/Sonarr, etc.).
2. Only then: **Translate with Gemini** into another language.

### Eligible / ineligible subtitles

| Eligible | Ineligible |
|----------|------------|
| External file with `relativePath` (`.srt`, `.ass`, `.vtt` converted) | Embedded without a file (`streamIndex` only, no `relativePath`) |
| SRT or ASS convertible to SRT | Bitmap: `hdmv_pgs_subtitle`, `dvd_subtitle`, `dvb_subtitle` |
| `DOWNLOADED` status or disk equivalent | Subtitle with no resolvable path |

**Backend:** reject with `400` and an explicit message when there is no text source.  
**Frontend:** hide or disable the “Translate” action with a tooltip explaining that a file-based subtitle is required first.

---

## Goals

| Goal | Success criteria |
|------|------------------|
| Translate a text SRT/ASS into a new language | New file + `subtitle_files` row, source unchanged |
| Admin config (key + **all operational settings**) | **Subtitle providers** page, type `gemini`, write-only key |
| Quality | Media context + per-cue CPS constraints |
| Robustness | Async queue, 429 retries, no blocking HTTP timeout |
| Monitoring | Local RPM/RPD/token counters + admin usage panel |
| Free tier | Conservative defaults, editable in UI |

**Out of scope v1:** GCP Monitoring / service account, bitmap translation, translation without a source file.

---

## Configurable settings (admin UI)

All settings below are stored in `subtitle_providers.settings` (provider `gemini`) and **editable in the admin UI** — code constants are only **default values** when creating the provider.

| UI field | `settings` key | Default | Description |
|----------|----------------|---------|-------------|
| API key | `apiKey` | *(empty)* | Write-only: never returned on GET |
| Model | `model` | `gemini-2.5-flash-lite` | Dropdown or free text (Flash-Lite, Flash, etc.) |
| Max requests / minute | `maxRpm` | `10` | Fliks-side throttle |
| Max requests / day | `maxRpd` | `250` | Daily cap (typical free tier) |
| RPD reserve margin | `reserveRpd` | `20` | Reject / queue if `usage + estimate > maxRpd - reserveRpd` |
| Chunk size (cues) | `chunkSize` | `35` | Cues per Gemini call |
| Concurrent jobs | `maxConcurrentJobs` | `1` | Max parallel translations |
| Max lines / cue | `maxLinesPerCue` | `2` | Subtitle rule |
| Max chars / line | `maxCharsPerLine` | `42` | Subtitle rule |
| CPS margin | `cpsMargin` | `1.05` | `targetCps = min(sourceCps × cpsMargin, maxCps)` |
| Absolute max CPS | `maxCps` | `20` | Hard ceiling |
| Suggested target languages | `targetLanguages` | `["fr","en","de","es","it"]` | User modal list (JSON array) |
| Enabled | `enabled` (column) | `true` | Active provider |

**Admin validation (frontend + DTO):**

- `maxRpm`: 1–60  
- `maxRpd`: 10–10000  
- `reserveRpd`: 0–500, `< maxRpd`  
- `chunkSize`: 10–80  
- `maxConcurrentJobs`: 1–3  
- `cpsMargin`: 1.0–1.5  

---

## Target architecture

```mermaid
flowchart TB
  subgraph admin [Admin subtitle-providers]
    SP[Gemini settings UI]
    SP -->|PUT settings| ProvDB[(subtitle_providers)]
    SP -->|GET usage| UsageAPI[/api/subtitles/gemini/usage]
  end

  subgraph user [User]
    Modal[subtitles-modal]
    Modal -->|POST translate if file source| MC[media.controller]
  end

  MC --> Val{Text source?}
  Val -->|no| Err400[400 no file]
  Val -->|yes| TQ[SubtitleTranslateService]
  TQ --> Quota[GeminiQuotaService]
  TQ --> Parse[srt-parser + cps]
  TQ --> Ctx[MediaContextBuilder]
  TQ --> Gemini[GeminiClient]
  Gemini --> Google[Gemini API]
  Quota --> StatsDB[(gemini_usage_daily)]
  TQ --> FS[New .lang.srt]
  TQ --> SubDB[(subtitle_files)]
  TQ --> SSE[subtitle.translated]
```

---

## Phase 0 — Prerequisites

**Duration:** 0.5 d

- [ ] Branch `feat/gemini-subtitle-translation`
- [ ] Dependency `@google/generative-ai`
- [ ] **Defaults only** (see UI table) in `gemini-defaults.ts`
- [ ] Privacy note in admin UI (Google free tier)

---

## Phase 1 — Data model

**Duration:** 1 d

### 1.1 Enum

- `SubtitleProviderType.GEMINI = 'gemini'`
- Migration: `ADD VALUE 'gemini'` on provider + `subtitle_files` enums

### 1.2 Monitoring table

`gemini_usage_daily`:

| Column | Description |
|--------|-------------|
| `date` | **America/Los_Angeles** calendar day (Google RPD reset) |
| `model` | Model name |
| `requestCount` | API requests |
| `inputTokens` / `outputTokens` | From `usageMetadata` |
| `error429Count` / `last429At` | Quota adaptation |

### 1.3 `gemini` provider

See **Configurable settings** table — full `settings` jsonb structure.

---

## Phase 2 — Backend: write-only key & admin provider

**Duration:** 1 d

### 2.1 Sanitization

- `GET` providers: for `gemini`, replace `apiKey` with `apiKeyConfigured: boolean` only
- `PUT`: empty `apiKey` = keep existing
- Never log the key

### 2.2 `GeminiProvider` + factory

- `testConnection()` only
- No `search()` / `download()` used by the scheduler

### 2.3 `GeminiConfigService`

- `getActiveProvider()`: enabled + type gemini
- `getSettings()`: all numeric fields with fallback to `gemini-defaults.ts`

---

## Phase 3 — Source eligibility (file prerequisite)

**Duration:** 0.5 d (wired everywhere)

### 3.1 `SubtitleTranslateEligibility`

**New file:** `subtitle-translate-eligibility.ts`

```typescript
function canTranslate(sub: SubtitleFile): { ok: boolean; reason?: string }
```

Rules:

1. `relativePath` is not null  
2. Codec not in `BITMAP_CODECS`  
3. File resolvable on disk (`resolveSubtitleAbsolute`)  
4. Text extension / content (not binary)

### 3.2 Endpoints & UI

- `POST translate`: call `canTranslate` first  
- `GET .../subtitles/:id/translate/preview` (optional v1): `{ eligible, estimatedRequests, estimatedMinutes, quota }`  
- Modal: show button only if `canTranslate(sub)`; otherwise link to existing “Search / download subtitle” flow

**i18n keys (English copy examples):**

- `gemini.no_source_subtitle` — “No subtitle file to translate. Download or import a subtitle first.”
- `gemini.embedded_not_supported` — “Embedded subtitles without an external file cannot be translated.”
- `gemini.bitmap_not_supported` — “Image-based subtitles (PGS, etc.) are not supported.”

---

## Phase 4 — SRT parsing, CPS, media context

**Duration:** 1.5 d

- `srt-parser.ts`, `srt-writer.ts`, `srt-cps.ts` (uses `maxLinesPerCue`, `maxCharsPerLine`, `cpsMargin`, `maxCps` from admin settings)
- ASS → SRT via `postProcess.assToSrt` when needed
- `MediaContextBuilder`: title, episode, genres, overview, limited cast

---

## Phase 5 — Gemini client & prompts

**Duration:** 1.5 d

- `GeminiClient`: `translateChunk`, `usageMetadata`, 429 handling
- JSON prompt: index + text + `constraints.maxChars` / `maxLines`
- Validation: timestamps **never** modified by the model

---

## Phase 6 — Monitoring (`GeminiQuotaService`)

**Duration:** 1 d

- RPM counter (60 s window) + RPD (daily PT table)
- `canMakeRequest(n)` uses `maxRpd`, `reserveRpd`, `maxRpm` **from admin settings**
- `recordSuccess` / `record429` + backoff / `Retry-After`
- `GET /api/subtitles/gemini/usage` — admin
- `GET /api/subtitles/gemini/usage/history?days=7` — optional v1

---

## Phase 7 — Translation service & queue

**Duration:** 2 d

### 7.1 `SubtitleTranslateService`

Modeled on `SubtitleSyncService`:

1. **Eligibility** (`canTranslate`)  
2. Provider config + quota (`estimatedChunks = ceil(cues / chunkSize)`)  
3. Chunk loop with `throttle(maxRpm)`  
4. Write `{stem}.{targetLang}.srt`  
5. New `subtitle_files` row (`providerType: GEMINI`)  
6. SSE `subtitle.translated`

`maxConcurrentJobs` read from admin settings.

### 7.2 Routes

| Method | Route | Notes |
|--------|-------|-------|
| POST | `/api/media/:id/subtitles/:subtitleId/translate` | `{ targetLanguage }` |
| GET | `/api/media/:id/subtitles/:subtitleId/translate/preview` | Eligibility + estimate |
| GET | `/api/media/subtitles/translate-queue` | Queue state |

---

## Phase 8 — Admin frontend (subtitle providers)

**Duration:** 1.5 d

**Files:**

- `subtitle-providers.ts` / `.html`
- `subtitle-providers-api.service.ts` (types if needed)
- `fr.json` / `en.json`

### 8.1 Provider type `gemini`

Dedicated form (not apiKey only):

- API key (password, “leave blank to keep” placeholder)
- Model (select + free text)
- **maxRpm, maxRpd, reserveRpd**
- **chunkSize, maxConcurrentJobs**
- **maxLinesPerCue, maxCharsPerLine, cpsMargin, maxCps**
- **targetLanguages** (multi-lang tags or JSON textarea)
- Enabled / priority toggles

### 8.2 Usage panel

Below the form or on the provider row:

- Bar: `requests today: X / maxRpd`
- Tokens in/out
- Last 429
- Link “View limits in AI Studio”

### 8.3 Test connection

Existing button → `testConnection` with form settings (entered key or stored key).

---

## Phase 9 — User frontend (subtitles-modal)

**Duration:** 1 d

- **Translate with Gemini** action — **visible only** when preview/eligibility `ok`
- Modal: target language (list from admin `targetLanguages`)
- Preview: `~N requests`, estimated duration, daily quota
- If no file subtitle on the video file: no global translate button; hint “Download a subtitle first”
- SSE `subtitle.translated` → reload list

---

## Phase 10 — i18n, permissions, docs

- Keys `gemini.*`, `settings.subtitle_providers.gemini_*`
- CASL: `Create` / `Read` on `SubtitleFile` / `SubtitleProvider`
- This file = spec; optional short admin README

---

## Phase 11 — Tests

| Area | Cases |
|------|-------|
| Eligibility | embedded / bitmap / no path → `ok: false` |
| Eligibility | `.srt` with path → `ok: true` |
| Quota | respect `maxRpm` / reject at `maxRpd - reserveRpd` |
| Sanitization | GET without `apiKey` |
| Translation | mock Gemini, new file + DB |
| UI | button hidden when ineligible |

---

## Implementation order

```
0 → 1 → 2 → 3 (eligibility) → 4 → 6 → 5 → 7 → 8 → 9 → 10 → 11
```

---

## Estimates

| Scope | Days |
|-------|------|
| Full (7-day usage history, preview endpoint) | ~13 |
| MVP (eligibility + full admin settings UI + daily monitoring) | ~9 |

---

## Suggested PR split

| PR | Content |
|----|---------|
| 1 | Enum, migration, defaults, sanitization, gemini admin UI (full settings) |
| 2 | Eligibility, SRT/CPS, GeminiClient, QuotaService |
| 3 | TranslateService, routes, SSE |
| 4 | subtitles-modal + preview + i18n + tests |

---

## Delivery checklist

- [ ] Admin can configure all settings (RPM, RPD, chunk, CPS…) without redeploying
- [ ] API key never exposed after save
- [ ] Translation rejected without a text source file (API + UI)
- [ ] Translation works on disk SRT → new `.xx.srt`
- [ ] Daily usage visible in admin
- [ ] 429 handled without crash; clear quota message
- [ ] User understands a subtitle must exist first (unlike OpenSubtitles)

---

## Future phase (optional)

- GCP Monitoring (service account + Cloud Monitoring)
- Queue deferred until next day (midnight PT) when RPD exceeded
