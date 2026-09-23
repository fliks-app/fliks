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
    expect(buildSystemInstruction(req('de', 'Sie'))).toContain('use "du" instead');
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
