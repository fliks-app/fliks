import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { TranslationProviderService } from './translation-provider.service';
import type { TranslationProvider } from './entities/translation-provider.entity';

const provider = (
  settings: Record<string, unknown>,
  engine: TranslationProvider['engine'] = 'gemini',
) =>
  ({
    id: 1,
    name: 'p',
    engine,
    enabled: true,
    isDefault: false,
    settings,
  }) as TranslationProvider;

function serviceWith(row: TranslationProvider) {
  const repo = { findOne: jest.fn(async () => row) };
  const factory = {
    listModels: jest.fn(async (..._args: unknown[]) => ['model-a', 'model-b']),
  };
  return {
    service: new TranslationProviderService(repo as never, factory as never),
    repo,
    factory,
  };
}

describe('TranslationProviderService.listModels', () => {
  it('dispatches to the factory for the given engine', async () => {
    const { service, factory } = serviceWith(provider({ apiKey: 'k' }));

    await expect(service.listModels('gemini', { apiKey: 'k' }, 1)).resolves.toEqual({
      models: ['model-a', 'model-b'],
    });
    expect(factory.listModels).toHaveBeenCalledWith('gemini', { apiKey: 'k' });
  });

  it('lists with the stored key an edit omitted', async () => {
    const { service, factory } = serviceWith(provider({ apiKey: 'stored', model: 'm' }));

    await service.listModels('gemini', { model: 'm' }, 1);

    expect(factory.listModels.mock.calls[0][1]).toEqual({ model: 'm', apiKey: 'stored' });
  });

  it('does not resolve a stored key into a different engine', async () => {
    const { service, factory } = serviceWith(provider({ apiKey: 'gemini-key' }));

    await service.listModels('openai', { baseUrl: 'http://ollama:11434', model: 'llama' }, 1);

    expect(factory.listModels.mock.calls[0][1]).toEqual({
      baseUrl: 'http://ollama:11434',
      model: 'llama',
    });
  });

  it('does not resolve a stored key into an edited host under the same engine', async () => {
    const { service, factory } = serviceWith(
      provider({ apiKey: 'k', baseUrl: 'http://old-host' }, 'openai'),
    );

    await service.listModels('openai', { baseUrl: 'http://new-host', model: 'm' }, 1);

    expect(factory.listModels.mock.calls[0][1]).toEqual({
      baseUrl: 'http://new-host',
      model: 'm',
    });
  });

  it('wraps an upstream failure as a gateway error', async () => {
    const { service, factory } = serviceWith(provider({ apiKey: 'k' }));
    factory.listModels.mockRejectedValueOnce(new Error('502 from upstream'));

    await expect(service.listModels('gemini', { apiKey: 'k' }, 1)).rejects.toThrow(
      BadGatewayException,
    );
  });

  it('lets a factory HttpException through unwrapped', async () => {
    const { service, factory } = serviceWith(provider({ apiKey: 'k' }));
    factory.listModels.mockRejectedValueOnce(
      new BadRequestException('Gemini API key is not set'),
    );

    await expect(service.listModels('gemini', { apiKey: '' }, 1)).rejects.toThrow(
      BadRequestException,
    );
  });
});
