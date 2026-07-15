import { APP_LANGUAGES } from '../../common/constants/app-languages';

/** Thrown when Gemini returns 429 (quota exhausted / rate limited) after
 *  retries — lets the caller surface a specific message to the client. */
export class GeminiRateLimitError extends Error {}

/** Minimal media context injected into the prompt to improve translation. */
export interface TranslationContext {
  title?: string | null;
  year?: number | null;
  mediaType?: string | null;
  genres?: string[] | null;
  overview?: string | null;
}

export interface GeminiTranslateOptions {
  apiKey: string;
  model: string;
  /** ISO 639-1 source code, or 'und'/empty when unknown. */
  sourceLanguage: string;
  /** ISO 639-1 target code. */
  targetLanguage: string;
  context: TranslationContext;
}

/** Cues sent per Gemini request. Large batches keep the total request count
 *  (and thus quota consumption) low; a response that outgrows the output-token
 *  budget re-maps as a mismatch and is split, so this stays safe. */
const BATCH_SIZE = 150;
const MAX_OUTPUT_TOKENS = 8192;
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
/** Per-request cap so a stalled connection can't hold a translation slot open. */
const REQUEST_TIMEOUT_MS = 120_000;
/** Attempts (1 initial + retries) for transient failures before giving up. */
const MAX_ATTEMPTS = 4;
/** Statuses worth retrying with backoff (rate limits + transient server errors). */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 30_000);
}

/** Gemini reports the wait for a 429 in the error body's RetryInfo (e.g.
 *  "38s"), not the Retry-After header — parse it so per-minute quota bursts
 *  recover instead of failing on the short default backoff. */
function parseRetryDelayMs(body: string): number | null {
  try {
    const details = JSON.parse(body)?.error?.details;
    if (Array.isArray(details)) {
      for (const d of details) {
        const m = typeof d?.retryDelay === 'string' && d.retryDelay.match(/^([\d.]+)s$/);
        if (m) return Math.round(parseFloat(m[1]) * 1000);
      }
    }
  } catch {
    // body wasn't JSON — fall back to the computed backoff
  }
  return null;
}

function languageName(iso: string): string {
  if (!iso || iso === 'und' || iso === 'xx') return 'the original language';
  return APP_LANGUAGES.find((l) => l.isoCode === iso)?.name ?? iso;
}

/**
 * The prompt is deliberately terse to save tokens: it carries the constraints
 * and a little media context, and asks for numbered segments back so the
 * timings never need to travel to the model.
 */
function buildSystemInstruction(opts: GeminiTranslateOptions): string {
  const { context } = opts;
  const kind = context.mediaType === 'series' ? 'series' : 'movie';
  const bits: string[] = [];
  if (context.title) {
    bits.push(
      `titled "${context.title}"${context.year ? ` (${context.year})` : ''}`,
    );
  }
  if (context.genres?.length) bits.push(`genres: ${context.genres.join(', ')}`);
  const contextLine = bits.length ? ` This is a ${kind} ${bits.join(', ')}.` : '';
  const synopsis = context.overview?.trim()
    ? ` Synopsis: ${context.overview.trim().slice(0, 300)}`
    : '';
  return [
    `You are a professional subtitle translator. Translate the subtitle segments from ${languageName(opts.sourceLanguage)} to ${languageName(opts.targetLanguage)}.${contextLine}${synopsis}`,
    'Each input segment is introduced by a line "#N#" where N is its number.',
    'Return every translation introduced by the same "#N#" line, in the same order, using the exact same set of numbers.',
    'Preserve line breaks within a segment. Keep proper nouns and names. Keep it concise and natural for on-screen subtitles.',
    'Output only the numbered translations — no notes, no explanations, no code fences.',
  ].join('\n');
}

function buildPayload(texts: string[]): string {
  return texts.map((t, i) => `#${i + 1}#\n${t}`).join('\n');
}

/** Re-map a numbered response back to an ordered array. Returns null when any
 *  segment is missing (truncated/garbled output) so the caller can split+retry. */
function parseNumbered(response: string, count: number): string[] | null {
  const map = new Map<number, string[]>();
  let current: number | null = null;
  for (const line of response.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*```/.test(line)) continue;
    // Accept both a marker alone on its line and an inline "#N# text" form, so
    // the common model formatting doesn't silently defeat the re-map.
    const marker = line.match(/^\s*#(\d+)#[ \t]*(.*)$/);
    if (marker) {
      current = Number(marker[1]);
      map.set(current, marker[2] ? [marker[2]] : []);
      continue;
    }
    if (current != null) map.get(current)!.push(line);
  }
  const out: string[] = [];
  for (let i = 1; i <= count; i++) {
    const seg = map.get(i);
    if (!seg) return null;
    out.push(seg.join('\n').trim());
  }
  return out;
}

/** Single Gemini call for one batch. Retries transient failures (rate limits,
 *  5xx, network/timeout) with backoff; throws on non-retryable errors or once
 *  attempts are exhausted (so the run fails cleanly). Returns null on a content
 *  mismatch (so the caller can split the batch). */
async function callGemini(
  texts: string[],
  opts: GeminiTranslateOptions,
): Promise<string[] | null> {
  const url = `${GEMINI_BASE}/${encodeURIComponent(opts.model)}:generateContent?key=${encodeURIComponent(opts.apiKey)}`;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: buildSystemInstruction(opts) }] },
    contents: [{ role: 'user', parts: [{ text: buildPayload(texts) }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: MAX_OUTPUT_TOKENS },
  });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // Network error or request timeout — retry with backoff, then give up.
      if (attempt >= MAX_ATTEMPTS) {
        throw new Error(
          `Gemini request failed after ${MAX_ATTEMPTS} attempts: ${String(err)}`,
        );
      }
      await sleep(backoffDelay(attempt));
      continue;
    }

    if (res.ok) {
      const data: any = await res.json();
      const parts = data?.candidates?.[0]?.content?.parts;
      if (!Array.isArray(parts)) return null;
      const text = parts.map((p: any) => p?.text ?? '').join('');
      return parseNumbered(text, texts.length);
    }

    const errText = await res.text().catch(() => '');
    if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
      const headerRetry = Number(res.headers.get('retry-after'));
      const suggested =
        parseRetryDelayMs(errText) ??
        (Number.isFinite(headerRetry) && headerRetry > 0 ? headerRetry * 1000 : null);
      // Honour the server's hint (capped) but never wait less than the backoff.
      const delay = Math.min(
        Math.max(suggested ?? 0, backoffDelay(attempt)),
        60_000,
      );
      await sleep(delay);
      continue;
    }
    if (res.status === 429) {
      const retryMs = parseRetryDelayMs(errText);
      const scope = /PerDay/i.test(errText)
        ? 'daily'
        : /PerMinute/i.test(errText)
          ? 'per-minute'
          : 'unknown';
      throw new GeminiRateLimitError(
        `Gemini quota/rate limit exceeded (scope=${scope}${retryMs ? `, retryDelay=${Math.round(retryMs / 1000)}s` : ''}): ${errText.slice(0, 500)}`,
      );
    }
    throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 300)}`);
  }
  throw new Error('Gemini request failed: retries exhausted');
}

/** Translate one batch, halving on a mismatch down to single segments; a
 *  single segment that still can't be parsed keeps its source text. */
async function translateWithRetry(
  texts: string[],
  opts: GeminiTranslateOptions,
): Promise<string[]> {
  if (texts.length === 0) return [];
  const result = await callGemini(texts, opts);
  if (result && result.length === texts.length) return result;
  if (texts.length === 1) return [texts[0]];
  const mid = Math.floor(texts.length / 2);
  const [left, right] = [
    await translateWithRetry(texts.slice(0, mid), opts),
    await translateWithRetry(texts.slice(mid), opts),
  ];
  return [...left, ...right];
}

/**
 * Translate subtitle cue texts to the target language via Gemini, preserving
 * order and count. Only the texts travel to the model (no timings/indices), and
 * `onProgress(done, total)` fires after each batch.
 */
export async function translateSubtitleTexts(
  texts: string[],
  opts: GeminiTranslateOptions,
  onProgress?: (done: number, total: number) => void,
): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    out.push(...(await translateWithRetry(batch, opts)));
    onProgress?.(Math.min(i + BATCH_SIZE, texts.length), texts.length);
  }
  return out;
}
