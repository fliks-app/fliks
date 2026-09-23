import {
  BATCH_SIZE,
  BatchTranslator,
  MAX_OUTPUT_TOKENS,
  TranslationLimits,
  TranslationPayloadTooLargeError,
  TranslationRequest,
  buildPayload,
  buildSystemInstruction,
  parseNumbered,
  withRegister,
  postWithRetry,
  translateWithBatching,
} from './translation-core';

export interface OpenAiConfig {
  /** Base URL up to and including the API version, e.g.
   *  https://api.groq.com/openai/v1 — "/chat/completions" is appended. */
  baseUrl: string;
  /** Optional bearer token (omitted for keyless local servers like Ollama). */
  apiKey: string;
  model: string;
  /** Prompt + reserved output ceiling per request; 0 = engine maximum. */
  maxTokensPerRequest: number;
  /** Token allowance per minute for this endpoint; 0 = unpaced. */
  tokensPerMinute: number;
}

/**
 * Translate cue texts via any OpenAI-compatible chat-completions endpoint
 * (Groq, OpenRouter, Mistral, a local Ollama server, Gemini's OpenAI layer…).
 */
export async function translateWithOpenAi(
  texts: string[],
  req: TranslationRequest,
  cfg: OpenAiConfig,
  onProgress?: (done: number, total: number) => void,
): Promise<string[]> {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;

  const ask = async (system: string, user: string): Promise<string> => {
    const res = await postWithRetry(
      url,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: cfg.model,
          temperature: 0,
          max_tokens: 16,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      },
      'OpenAI-compatible',
    );
    const data: any = await res.json();
    return String(data?.choices?.[0]?.message?.content ?? '');
  };
  const system = buildSystemInstruction(await withRegister(req, texts, ask));
  const limits: TranslationLimits = {
    maxTokensPerRequest: cfg.maxTokensPerRequest,
    tokensPerMinute: cfg.tokensPerMinute,
    key: `openai:${url}:${cfg.model}`,
    outputCeiling: MAX_OUTPUT_TOKENS,
    batchCeiling: BATCH_SIZE,
  };

  const callBatch: BatchTranslator = async (batch, maxOutputTokens) => {
    const res = await postWithRetry(
      url,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: cfg.model,
          temperature: 0.3,
          max_tokens: maxOutputTokens,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: buildPayload(batch) },
          ],
        }),
      },
      'OpenAI-compatible',
    );
    const data: any = await res.json();
    const choice = data?.choices?.[0];
    // Ollama caps the whole exchange at its own num_ctx, which no OpenAI field
    // can raise, so a batch too big for it comes back cut rather than refused.
    if (choice?.finish_reason === 'length') {
      throw new TranslationPayloadTooLargeError(
        `OpenAI-compatible endpoint truncated ${batch.length} cues at its context limit (usage=${JSON.stringify(data?.usage)}); set maxTokensPerRequest to what it actually accepts`,
      );
    }
    const text = choice?.message?.content;
    if (typeof text !== 'string') return null;
    return parseNumbered(text, batch.length);
  };
  return translateWithBatching(texts, callBatch, limits, system, onProgress);
}
