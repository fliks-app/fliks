import { TranslationRequest, postWithRetry } from './translation-core';

export interface LibreTranslateConfig {
  /** Base URL of the LibreTranslate server, e.g. http://libretranslate:5000. */
  url: string;
  /** Optional api_key (self-hosted instances usually need none). */
  apiKey: string;
}

/** Cues per LibreTranslate request — it translates an array 1:1, so no prompt
 *  or numbered re-map is needed; chunking just bounds the payload size. */
const CHUNK = 100;

/**
 * Translate cue texts with a (self-hosted) LibreTranslate server. Unlike the LLM
 * engines this is a dedicated translation API: each cue maps 1:1, so order is
 * preserved by construction. A chunk whose response doesn't line up falls back
 * to the source text to keep the SRT aligned.
 */
export async function translateWithLibreTranslate(
  texts: string[],
  req: TranslationRequest,
  cfg: LibreTranslateConfig,
  onProgress?: (done: number, total: number) => void,
): Promise<string[]> {
  const url = `${cfg.url.replace(/\/+$/, '')}/translate`;
  const source =
    req.sourceLanguage && req.sourceLanguage !== 'und' ? req.sourceLanguage : 'auto';
  const out: string[] = [];
  for (let i = 0; i < texts.length; i += CHUNK) {
    const chunk = texts.slice(i, i + CHUNK);
    const res = await postWithRetry(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          q: chunk,
          source,
          target: req.targetLanguage,
          format: 'text',
          ...(cfg.apiKey ? { api_key: cfg.apiKey } : {}),
        }),
      },
      'LibreTranslate',
    );
    const data: any = await res.json();
    const t = data?.translatedText;
    const arr = Array.isArray(t)
      ? t
      : chunk.length === 1 && typeof t === 'string'
        ? [t]
        : null;
    if (arr && arr.length === chunk.length) {
      out.push(...arr.map((x: any) => String(x)));
    } else {
      // Unexpected shape — keep the source text so timings stay aligned.
      out.push(...chunk);
    }
    onProgress?.(Math.min(i + CHUNK, texts.length), texts.length);
  }
  return out;
}
