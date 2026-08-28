import { ServiceUnavailableException } from '@nestjs/common';
import { MetadataProvidersController } from './metadata-providers.controller';

/**
 * A provider that throws used to reach the client as a bare 500 ("Scan failed." in the
 * orphan-scan panel), hiding whether the key was rejected, the quota spent, or TMDB down.
 */
describe('MetadataProvidersController — a failed provider search', () => {
  function harness(err: unknown) {
    const logged: string[] = [];
    const controller = Object.create(
      MetadataProvidersController.prototype,
    ) as MetadataProvidersController;
    Object.assign(controller, {
      logger: {
        log: jest.fn(),
        error: jest.fn((msg: string) => logged.push(msg)),
      },
      registry: {
        resolve: () => ({
          name: 'tmdb',
          searchMovie: () => Promise.reject(err),
          searchTvShow: () => Promise.reject(err),
        }),
        getFallback: () => null,
      },
      mediaRepo: { findOne: () => Promise.resolve(null) },
      enrichWithExisting: (r: unknown[]) => Promise.resolve(r),
    });
    return { controller, logged };
  }

  it("VERDICT: answers 503 carrying the upstream's own message, and logs it", async () => {
    const { controller, logged } = harness({
      isAxiosError: true,
      message: 'Request failed with status code 401',
      response: { status: 401, data: { status_message: 'Invalid API key' } },
    });

    await expect(controller.searchMovie('a film', '2019')).rejects.toThrow(
      ServiceUnavailableException,
    );
    await expect(controller.searchMovie('a film', '2019')).rejects.toThrow(
      /tmdb: HTTP 401 — Invalid API key/,
    );
    expect(logged[0]).toContain('movie q="a film" year=2019');
    expect(logged[0]).toContain('HTTP 401 — Invalid API key');
  });

  it('reports a dead socket as its axios code rather than a status', async () => {
    const { controller } = harness({
      isAxiosError: true,
      code: 'ECONNREFUSED',
      message: 'connect ECONNREFUSED',
    });

    await expect(controller.searchTv('a series')).rejects.toThrow(
      /ECONNREFUSED/,
    );
  });

  it('falls back to a plain error message (breaker open, for instance)', async () => {
    const { controller } = harness(
      new Error('tmdb circuit open — upstream temporarily unreachable'),
    );

    await expect(controller.searchMovie('a film')).rejects.toThrow(
      /circuit open/,
    );
  });
});
