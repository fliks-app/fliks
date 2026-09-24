import { Logger } from '@nestjs/common';
import {
  BatchTranslator,
  REGISTER_PROBE_MAX_OUTPUT_TOKENS,
  TranslationLimits,
  TranslationPayloadTooLargeError,
  TranslationRequest,
  buildPayload,
  buildSystemInstruction,
  withRegister,
  parseNumbered,
  postWithRetry,
  translateWithBatching,
} from './translation-core';

export interface GeminiConfig {
  apiKey: string;
  model: string;
  /** Prompt + reserved output ceiling per request; 0 = engine maximum. */
  maxTokensPerRequest: number;
  /** Token allowance per minute for this model; 0 = unpaced. */
  tokensPerMinute: number;
}

const log = new Logger('GeminiTranslator');

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
/** Every Gemini 3.x flash model reports this much output; a 1M input window
 *  means the batch is never bound by the prompt side. */
const GEMINI_OUTPUT_CEILING = 65_536;
/** Cues per request. The free tier meters requests per day, so a whole film in
 *  one call is the point; the cap only keeps the bar moving a few times. */
const GEMINI_BATCH_CEILING = 500;

/** Thinking is on by default and its tokens come out of maxOutputTokens, which
 *  starves the translation and empties the response. The two families take
 *  different values for the lowest setting. */
function thinkingConfig(model: string): Record<string, unknown> {
  if (/^gemini-3/.test(model))
    return { thinkingConfig: { thinkingLevel: 'low' } };
  if (/^gemma-4/.test(model))
    return { thinkingConfig: { thinkingLevel: 'minimal' } };
  return {};
}

/** Joins a Gemini response's text parts into one string. */
function joinParts(parts: unknown): string {
  return Array.isArray(parts)
    ? parts.map((p: any) => p?.text ?? '').join('')
    : '';
}

/** Translate cue texts via the native Gemini generateContent endpoint. */
export async function translateWithGemini(
  texts: string[],
  req: TranslationRequest,
  cfg: GeminiConfig,
  onProgress?: (done: number, total: number) => void,
): Promise<string[]> {
  const url = `${GEMINI_BASE}/${encodeURIComponent(cfg.model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
  const ask = async (system: string, user: string): Promise<string> => {
    const res = await postWithRetry(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: REGISTER_PROBE_MAX_OUTPUT_TOKENS,
            ...thinkingConfig(cfg.model),
          },
        }),
      },
      'Gemini',
    );
    const data: any = await res.json();
    return joinParts(data?.candidates?.[0]?.content?.parts);
  };
  const system = buildSystemInstruction(await withRegister(req, texts, ask));
  const limits: TranslationLimits = {
    maxTokensPerRequest: cfg.maxTokensPerRequest,
    tokensPerMinute: cfg.tokensPerMinute,
    key: `gemini:${cfg.model}`,
    outputCeiling: GEMINI_OUTPUT_CEILING,
    batchCeiling: GEMINI_BATCH_CEILING,
  };
  const callBatch: BatchTranslator = async (batch, maxOutputTokens) => {
    const res = await postWithRetry(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: buildPayload(batch) }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens,
            ...thinkingConfig(cfg.model),
          },
        }),
      },
      'Gemini',
    );
    const data: any = await res.json();
    const candidate = data?.candidates?.[0];
    if (candidate?.finishReason === 'MAX_TOKENS') {
      throw new TranslationPayloadTooLargeError(
        `Gemini truncated ${batch.length} cues at the output budget (usage=${JSON.stringify(data?.usageMetadata)})`,
      );
    }
    const parts = candidate?.content?.parts;
    if (!Array.isArray(parts)) {
      log.warn(
        `Gemini returned no content for ${batch.length} cues (finishReason=${candidate?.finishReason}, usage=${JSON.stringify(data?.usageMetadata)})`,
      );
      return null;
    }
    return parseNumbered(joinParts(parts), batch.length);
  };
  return translateWithBatching(texts, callBatch, limits, system, onProgress);
}
