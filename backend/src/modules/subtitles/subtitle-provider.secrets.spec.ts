import { SubtitleProviderService, redactProviderSecrets } from './subtitle-provider.service';
import type { SubtitleProvider } from './entities/subtitle-provider.entity';

function provider(settings: Record<string, unknown>): SubtitleProvider {
  return { id: 1, name: 'p', type: 'opensubtitles', enabled: true, priority: 25, settings } as SubtitleProvider;
}

function fakeRepo(row: SubtitleProvider) {
  return {
    findOne: jest.fn(async () => row),
    save: jest.fn(async (p: SubtitleProvider) => p),
    find: jest.fn(async () => [row]),
    create: jest.fn(),
    remove: jest.fn(),
  };
}

describe('subtitle provider credentials', () => {
  it('strips every credential key but keeps the identifying username', () => {
    const redacted = redactProviderSecrets(
      provider({ username: 'someone', password: 'secret', apiKey: 'k', language: 'fr' }),
    );

    expect(redacted.settings).toEqual({
      username: 'someone',
      language: 'fr',
      secretsSet: ['password', 'apiKey'],
    });
  });

  it('leaves a provider carrying no credential untouched', () => {
    expect(redactProviderSecrets(provider({ language: 'fr' })).settings).toEqual({
      language: 'fr',
      secretsSet: [],
    });
  });

  it('keeps the stored credential when a save omits it, since no response ever returned it', async () => {
    const row = provider({ username: 'someone', password: 'stored-secret' });
    const repo = fakeRepo(row);
    const service = new SubtitleProviderService(repo as never, {} as never);

    // Exactly what a client can send back: the redacted settings it received.
    const saved = await service.update(1, { settings: { username: 'someone' } } as never);

    expect(saved.settings).toEqual({ username: 'someone', password: 'stored-secret' });
  });

  it('replaces the stored credential when a new one is actually typed', async () => {
    const repo = fakeRepo(provider({ username: 'someone', password: 'stored-secret' }));
    const service = new SubtitleProviderService(repo as never, {} as never);

    const saved = await service.update(1, { settings: { username: 'someone', password: 'fresh' } } as never);

    expect(saved.settings).toEqual({ username: 'someone', password: 'fresh' });
  });

  it('erases the stored credential when the client sends an explicit null', async () => {
    const repo = fakeRepo(provider({ username: 'someone', password: 'stored-secret' }));
    const service = new SubtitleProviderService(repo as never, {} as never);

    const saved = await service.update(1, { settings: { username: 'someone', password: null } } as never);

    expect(saved.settings).toEqual({ username: 'someone' });
  });

  it('drops a null credential on create instead of storing it', async () => {
    const repo = fakeRepo(provider({}));
    repo.create = jest.fn((p) => p as never);
    const service = new SubtitleProviderService(repo as never, {} as never);

    const saved = await service.create({ name: 'p', type: 'opensubtitles', settings: { apiKey: null } } as never);

    expect(saved.settings).toEqual({});
  });

  it('does not redact inside the service, because that is the path that authenticates', async () => {
    const repo = fakeRepo(provider({ password: 'stored-secret' }));
    const service = new SubtitleProviderService(repo as never, {} as never);

    await expect(service.findOne(1)).resolves.toMatchObject({ settings: { password: 'stored-secret' } });
  });
});
