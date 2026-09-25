import { translateWithLibreTranslate } from './libretranslate-translator';

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response;
}

describe('translateWithLibreTranslate', () => {
  it('translates a chunk 1:1', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve(jsonResponse({ translatedText: ['bonjour', 'salut'] })),
    ) as never;

    const out = await translateWithLibreTranslate(
      ['hello', 'hi'],
      { sourceLanguage: 'en', targetLanguage: 'fr', context: {} },
      { url: 'http://libretranslate:5000', apiKey: '' },
    );

    expect(out).toEqual(['bonjour', 'salut']);
  });

  it('keeps the source text for a chunk with an unexpected shape, without failing the ones that worked', async () => {
    // CHUNK is 25: 30 cues make two requests, so one bad chunk doesn't sink the run.
    const texts = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    let call = 0;
    global.fetch = jest.fn(() => {
      call++;
      const body = call === 1 ? { translatedText: ['only-one'] } : { translatedText: texts.slice(25).map((t) => `${t}!`) };
      return Promise.resolve(jsonResponse(body));
    }) as never;

    const out = await translateWithLibreTranslate(
      texts,
      { sourceLanguage: 'en', targetLanguage: 'fr', context: {} },
      { url: 'http://libretranslate:5000', apiKey: '' },
    );

    expect(out.slice(0, 25)).toEqual(texts.slice(0, 25));
    expect(out.slice(25)).toEqual(texts.slice(25).map((t) => `${t}!`));
  });

  it('throws instead of reporting an untranslated file as done', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve(jsonResponse({ translatedText: ['only-one'] })),
    ) as never;

    await expect(
      translateWithLibreTranslate(
        ['hello', 'hi'],
        { sourceLanguage: 'en', targetLanguage: 'fr', context: {} },
        { url: 'http://libretranslate:5000', apiKey: '' },
      ),
    ).rejects.toThrow(/no usable translation/);
  });
});
