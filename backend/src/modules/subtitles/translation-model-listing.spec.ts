import { listGeminiModels } from './gemini-translator';
import { listOpenAiModels } from './openai-translator';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

describe('translation model listing', () => {
  it('keeps only the Gemini models that can generate content, without the prefix', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve(
        jsonResponse({
          models: [
            { name: 'models/model-b', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/embedder', supportedGenerationMethods: ['embedContent'] },
            { name: 'models/model-a', supportedGenerationMethods: ['countTokens', 'generateContent'] },
          ],
        }),
      ),
    ) as never;
    await expect(listGeminiModels('key')).resolves.toEqual(['model-a', 'model-b']);
  });

  it('lists an OpenAI-compatible endpoint with its bearer key', async () => {
    const fetchMock = jest.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(jsonResponse({ data: [{ id: 'z' }, { id: 'a' }] })),
    );
    global.fetch = fetchMock as never;
    await expect(listOpenAiModels('http://host/v1/', 'secret')).resolves.toEqual(['a', 'z']);
    expect(fetchMock.mock.calls[0][0]).toBe('http://host/v1/models');
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer secret' });
  });

  it('surfaces the upstream refusal', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve(jsonResponse({ error: 'API key not valid' }, 400)),
    ) as never;
    await expect(listGeminiModels('bad')).rejects.toThrow(/400.*API key not valid/);
  });
});
