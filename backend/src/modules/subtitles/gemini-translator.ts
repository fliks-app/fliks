import {
  BatchTranslator,
  MAX_OUTPUT_TOKENS,
  TranslationRequest,
  buildPayload,
  buildSystemInstruction,
  parseNumbered,
  postWithRetry,
  translateWithBatching,
} from './translation-core';

export interface GeminiConfig {
  apiKey: string;
  model: string;
}

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Translate cue texts via the native Gemini generateContent endpoint. */
export async function translateWithGemini(
  texts: string[],
  req: TranslationRequest,
  cfg: GeminiConfig,
  onProgress?: (done: number, total: number) => void,
): Promise<string[]> {
  const system = buildSystemInstruction(req);
  const callBatch: BatchTranslator = async (batch) => {
    const url = `${GEMINI_BASE}/${encodeURIComponent(cfg.model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
    const res = await postWithRetry(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: buildPayload(batch) }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: MAX_OUTPUT_TOKENS },
        }),
      },
      'Gemini',
    );
    const data: any = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return null;
    return parseNumbered(parts.map((p: any) => p?.text ?? '').join(''), batch.length);
  };
  return translateWithBatching(texts, callBatch, onProgress);
}
