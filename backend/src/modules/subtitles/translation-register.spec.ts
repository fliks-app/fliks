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
  it('names both forms so the instruction is concrete', () => {
    expect(buildSystemInstruction(req('fr', 'tu'))).toContain(
      'Address the characters with "tu" throughout, never "vous"',
    );
    expect(buildSystemInstruction(req('de', 'Sie'))).toContain('never "du"');
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
