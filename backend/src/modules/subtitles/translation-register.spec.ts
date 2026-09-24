import { translateWithGemini } from './gemini-translator';
import {
  REGISTER_PROBE_MAX_OUTPUT_TOKENS,
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
      'These speakers use',
    );
  });

  it('skips languages that do not distinguish', () => {
    expect(hasRegisterChoice('en')).toBe(false);
    expect(buildRegisterProbe(req('en'), ['hi'])).toBeNull();
    expect(buildSystemInstruction(req('en', 'tu'))).not.toContain(
      'These speakers use',
    );
  });

  it('reads either form out of a one-word answer', () => {
    expect(parseRegister('Tu\n', 'fr')).toBe('tu');
    expect(parseRegister('  vous.', 'fr')).toBe('vous');
    expect(parseRegister('I cannot tell', 'fr')).toBeNull();
  });

  it('refuses an answer that names both forms rather than guessing', () => {
    // The two readings end on opposite words while meaning the same thing, so
    // position cannot decide; a refusal costs one probe, a wrong one the file.
    expect(parseRegister('Pas tu, mais vous.', 'fr')).toBeNull();
    expect(parseRegister('They use vous, not tu', 'fr')).toBeNull();
  });

  it('refuses when nothing outside an unterminated think block names a form', () => {
    expect(parseRegister('<think>tu? vous? still unsure', 'fr')).toBeNull();
  });

  it('strips a leading think block before reading the answer', () => {
    expect(
      parseRegister("<think>tu or vous? I'll go with</think>\nvous", 'fr'),
    ).toBe('vous');
  });

  it.each([
    ['fr', 'tu', 'vous'],
    ['de', 'du', 'Sie'],
    ['es', 'tú', 'usted'],
    ['it', 'tu', 'Lei'],
    ['pt', 'tu', 'você'],
    ['nl', 'je', 'u'],
    ['ru', 'ты', 'вы'],
  ])('%s: a bare one-word answer still names its own form', (lang, informal, formal) => {
    expect(parseRegister(informal, lang)).toBe(informal);
    expect(parseRegister(formal, lang)).toBe(formal);
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

describe('register probe token budget', () => {
  it('leaves room for a thinking model to still land the word', async () => {
    const bodies: string[] = [];
    let calls = 0;
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      bodies.push(init.body);
      calls++;
      // First call is the register probe (answers the bare word); the rest is
      // the real translate batch, which needs a properly numbered answer.
      const text = calls === 1 ? 'vous' : '#1#\nbonjour';
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }],
        }),
      };
    }) as never;
    await translateWithGemini(
      ['Bonjour, comment allez-vous ?'],
      { sourceLanguage: 'en', targetLanguage: 'fr', context: {} },
      { apiKey: 'k', model: 'gemini-2.5-flash', maxTokensPerRequest: 0, tokensPerMinute: 0 },
    );
    const probeBody = JSON.parse(bodies[0]);
    expect(probeBody.generationConfig.maxOutputTokens).toBe(
      REGISTER_PROBE_MAX_OUTPUT_TOKENS,
    );
    expect(REGISTER_PROBE_MAX_OUTPUT_TOKENS).toBeGreaterThan(16);
  });
});
