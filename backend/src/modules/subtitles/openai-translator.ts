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

export interface OpenAiConfig {
  /** Base URL up to and including the API version, e.g.
   *  https://api.groq.com/openai/v1 — "/chat/completions" is appended. */
  baseUrl: string;
  /** Optional bearer token (omitted for keyless local servers like Ollama). */
  apiKey: string;
  model: string;
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
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;

  const callBatch: BatchTranslator = async (batch) => {
    const res = await postWithRetry(
      url,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: cfg.model,
          temperature: 0.3,
          max_tokens: MAX_OUTPUT_TOKENS,
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
  return translateWithBatching(texts, callBatch, onProgress);
}
