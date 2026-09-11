import { AxiosError } from 'axios';
import { PersonsService } from './persons.service';

/** A person id only means something to the provider that issued it: a TVDB
 *  people id sent to TMDB 404s. */
describe('PersonsService.getProviderCredits, provider mismatch', () => {
  const credits = {
    cast: [{ externalId: 393187, title: 'Sample Series' }],
    crew: [],
  };

  function harness(tmdbError: unknown) {
    const personRepo = {
      findOne: jest.fn(() =>
        Promise.resolve({ id: 2752, provider: 'tmdb', tmdbId: 310628 }),
      ),
      update: jest.fn(() => Promise.resolve({})),
    };
    const tmdb = {
      name: 'tmdb',
      getPersonCredits: jest.fn(() => Promise.reject(tmdbError)),
    };
    const tvdb = {
      name: 'tvdb',
      getPersonCredits: jest.fn(() => Promise.resolve(credits)),
    };
    const providers = {
      resolve: jest.fn(() => tmdb),
      getFallback: jest.fn(() => tvdb),
    };
    const mediaRepo = {
      find: jest.fn(() => Promise.resolve([{ id: 38, tvdbId: 393187 }])),
    };

    const service = Object.create(PersonsService.prototype) as PersonsService;
    Object.assign(service, {
      personRepo,
      mediaRepo,
      providers,
      log: { log: jest.fn() },
    });
    return { service, personRepo, tvdb };
  }

  const notFound = () => {
    const err = new AxiosError('Request failed with status code 404');
    err.response = { status: 404 } as AxiosError['response'];
    return err;
  };

  it('retries on the other provider, pins the row and links owned media', async () => {
    const { service, personRepo, tvdb } = harness(notFound());

    await expect(service.getProviderCredits(2752)).resolves.toEqual({
      provider: 'tvdb',
      cast: [{ externalId: 393187, title: 'Sample Series', mediaId: 38 }],
      crew: [],
    });
    expect(tvdb.getPersonCredits).toHaveBeenCalledWith('310628');
    expect(personRepo.update).toHaveBeenCalledWith(2752, { provider: 'tvdb' });
  });

  it('propagates anything that is not a 404', async () => {
    const err = new AxiosError('timeout of 10000ms exceeded');
    const { service, personRepo, tvdb } = harness(err);

    await expect(service.getProviderCredits(2752)).rejects.toBe(err);
    expect(tvdb.getPersonCredits).not.toHaveBeenCalled();
    expect(personRepo.update).not.toHaveBeenCalled();
  });
});
