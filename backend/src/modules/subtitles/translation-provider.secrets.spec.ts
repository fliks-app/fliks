import {
  TranslationProviderService,
  redactTranslationProviderSecrets,
} from './translation-provider.service';
import type { TranslationProvider } from './entities/translation-provider.entity';

const provider = (settings: Record<string, unknown>) =>
  ({
    id: 1,
    name: 'p',
    engine: 'gemini',
    enabled: true,
    isDefault: false,
    settings,
  }) as TranslationProvider;

function serviceWith(row: TranslationProvider) {
  const repo = {
    findOne: jest.fn(async () => row),
    save: jest.fn(async (p: TranslationProvider) => p),
    create: jest.fn((p: unknown) => p),
    createQueryBuilder: jest.fn(),
  };
  const factory = {
    validateConfig: jest.fn(),
    translate: jest.fn(async (..._args: unknown[]) => ['bonjour']),
  };
  return {
    service: new TranslationProviderService(repo as never, factory as never),
    repo,
    factory,
  };
}

describe('translation provider credentials', () => {
  it('never returns the key, only whether one is set', () => {
    expect(
      redactTranslationProviderSecrets(
        provider({ apiKey: 'k', model: 'gemini-3.5-flash-lite' }),
      ).settings,
    ).toEqual({ model: 'gemini-3.5-flash-lite', secretsSet: ['apiKey'] });

    expect(
      redactTranslationProviderSecrets(provider({ model: 'm' })).settings,
    ).toEqual({
      model: 'm',
      secretsSet: [],
    });
  });

  it('keeps the stored key when a save omits it', async () => {
    const row = provider({ apiKey: 'stored', model: 'old' });
    const { service, repo } = serviceWith(row);

    await service.update(1, { settings: { model: 'new' } } as never);

    expect(repo.save.mock.calls[0][0].settings).toEqual({
      model: 'new',
      apiKey: 'stored',
    });
  });

  it('erases the stored key on an explicit null', async () => {
    const row = provider({ apiKey: 'stored', model: 'old' });
    const { service, repo } = serviceWith(row);

    await service.update(1, {
      settings: { model: 'old', apiKey: null },
    } as never);

    expect(repo.save.mock.calls[0][0].settings).toEqual({ model: 'old' });
  });

  it('tests a saved provider with the key the editor never received', async () => {
    const row = provider({ apiKey: 'stored', model: 'm' });
    const { service, factory } = serviceWith(row);

    await service.testConnection('gemini', { model: 'm' }, 1);

    expect(factory.translate.mock.calls[0][3]).toEqual({
      model: 'm',
      apiKey: 'stored',
    });
  });

  it('drops the stored key on save when the engine changes underneath it', async () => {
    const row = provider({ apiKey: 'gemini-key', model: 'old' });
    const { service, repo } = serviceWith(row);

    await service.update(1, {
      engine: 'openai',
      settings: { baseUrl: 'http://ollama:11434', model: 'llama' },
    } as never);

    expect(repo.save.mock.calls[0][0].settings).toEqual({
      baseUrl: 'http://ollama:11434',
      model: 'llama',
    });
  });

  it('drops the stored key on save when the host changes under the same engine', async () => {
    const row = {
      ...provider({ apiKey: 'k', baseUrl: 'http://old-host', model: 'm' }),
      engine: 'openai',
    } as TranslationProvider;
    const { service, repo } = serviceWith(row);

    await service.update(1, {
      settings: { baseUrl: 'http://new-host', model: 'm' },
    } as never);

    expect(repo.save.mock.calls[0][0].settings).toEqual({
      baseUrl: 'http://new-host',
      model: 'm',
    });
  });

  it('does not resolve a stored key into a test against a different engine', async () => {
    const row = provider({ apiKey: 'gemini-key', model: 'm' });
    const { service, factory } = serviceWith(row);

    await service.testConnection('openai', { baseUrl: 'http://ollama:11434', model: 'llama' }, 1);

    expect(factory.translate.mock.calls[0][3]).toEqual({
      baseUrl: 'http://ollama:11434',
      model: 'llama',
    });
  });
});
