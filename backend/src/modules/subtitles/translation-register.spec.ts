import { translateWithGemini } from './gemini-translator';
import {
  buildRegisterProbe,
  buildSystemInstruction,
  hasRegisterChoice,
  parseRegister,
  registerSample,
  withRegister,
  type TranslationRequest,
} from './translation-core';

const req = (
  targetLanguage: string,
  register?: string,
): TranslationRequest => ({
  sourceLanguage: 'en',
  targetLanguage,
  register,
  context: { mediaType: 'movie' },
});

describe('second-person register', () => {
  it('names both forms, and offers the other one for lines that ask for it', () => {
    const fr = buildSystemInstruction(req('fr', 'tu'));
    expect(fr).toContain('These speakers use "tu" with each other');
    // Not an override: a judge must still be addressed as one.
    expect(fr).toContain('use "vous" instead');
    expect(buildSystemInstruction(req('de', 'Sie'))).toContain(
      'use "du" instead',
    );
  });

  it('says nothing when no register was resolved', () => {
    expect(buildSystemInstruction(req('fr'))).not.toContain(
      'Address the characters with',
    );
  });

  it('skips languages that do not distinguish', () => {
    expect(hasRegisterChoice('en')).toBe(false);
    expect(buildRegisterProbe(req('en'), ['hi'])).toBeNull();
    expect(buildSystemInstruction(req('en', 'tu'))).not.toContain(
      'Address the characters with',
    );
  });

  it('reads either form out of a one-word answer', () => {
    expect(parseRegister('Tu\n', 'fr')).toBe('tu');
    expect(parseRegister('  vous.', 'fr')).toBe('vous');
    expect(parseRegister('I cannot tell', 'fr')).toBeNull();
  });

  it('samples unbroken runs, not every nth cue', () => {
    const texts = Array.from({ length: 600 }, (_, i) => `cue ${i}`);
    const sample = registerSample(texts, 2, 4).filter(Boolean);
    // Consecutive within each window: a scattered sample reads as strangers.
    expect(sample).toEqual([
      'cue 200',
      'cue 201',
      'cue 202',
      'cue 203',
      'cue 400',
      'cue 401',
      'cue 402',
      'cue 403',
    ]);
  });

  it('translates anyway when the probe fails', async () => {
    const resolved = await withRegister(req('fr'), ['a'], async () => {
      throw new Error('engine down');
    });
    expect(resolved.register).toBeUndefined();
  });

  it('asks nothing when the register is already known', async () => {
    const ask = jest.fn();
    await withRegister(req('fr', 'tu'), ['a'], ask);
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('thinking is disabled per model family', () => {
  /** Captures the request body of the first call, answering a valid batch. */
  async function firstBody(model: string): Promise<Record<string, any>> {
    const seen: string[] = [];
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      seen.push(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            {
              finishReason: 'STOP',
              content: { parts: [{ text: '#1#\nbonjour' }] },
            },
          ],
        }),
      };
    }) as never;
    await translateWithGemini(
      ['hello'],
      // A target with no register distinction, so no probe call comes first.
      { sourceLanguage: 'en', targetLanguage: 'ja', context: {} },
      { apiKey: 'k', model, maxTokensPerRequest: 0, tokensPerMinute: 0 },
    );
    return JSON.parse(seen[0]);
  }

  it.each([
    ['gemini-3.5-flash-lite', 'low'],
    ['gemma-4-26b-a4b-it', 'minimal'],
  ])('%s asks for "%s"', async (model, level) => {
    const body = await firstBody(model);
    expect(body.generationConfig.thinkingConfig.thinkingLevel).toBe(level);
  });

  it('sends nothing for a family that takes neither value', async () => {
    const body = await firstBody('gemini-2.5-flash');
    expect(body.generationConfig.thinkingConfig).toBeUndefined();
  });
});
