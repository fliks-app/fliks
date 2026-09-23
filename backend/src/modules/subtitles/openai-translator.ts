import {
  BatchTranslator,
  TranslationLimits,
  TranslationRequest,
  buildPayload,
  buildSystemInstruction,
  parseNumbered,
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
  const system = buildSystemInstruction(req);
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
  const limits: TranslationLimits = {
    maxTokensPerRequest: cfg.maxTokensPerRequest,
    tokensPerMinute: cfg.tokensPerMinute,
    key: `openai:${url}:${cfg.model}`,
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
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') return null;
    return parseNumbered(text, batch.length);
  };
  return translateWithBatching(texts, callBatch, limits, system, onProgress);
}
