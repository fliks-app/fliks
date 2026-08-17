import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FliksHostImpl } from './fliks-host.service';
import { InProcessPluginHostClient } from './in-process-plugin-host-client';
import { PluginHostBindingService } from './plugin-host-binding.service';
import { PluginCountsCacheService } from './plugin-counts-cache.service';
import { EventsService } from '../../scheduler/events.service';
import {
  HOST_METHOD_SCOPES,
  type PluginHostApi,
  type PluginScope,
} from '../../../common/plugin-contract';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeRepo() {
  const qb: Record<string, jest.Mock> = {};
  for (const m of ['select', 'addSelect', 'where', 'leftJoin']) {
    qb[m] = jest.fn(() => qb);
  }
  qb.getRawMany = jest.fn().mockResolvedValue([]);
  return {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    count: jest.fn().mockResolvedValue(0),
    save: jest.fn(),
    create: jest.fn((x: unknown) => x),
    createQueryBuilder: jest.fn(() => qb),
  };
}

/** Stand-in for the `plugin_registrations` table, keyed by plugin id.
 *  `delete` is what an uninstall does mid-connection, per `plugin-install.service.ts`. */
class FakeRegistrationRepo {
  private rows = new Map<
    string,
    { pluginId: string; ingestRoots: string[]; scopes: PluginScope[] }
  >();

  seed(pluginId: string, ingestRoots: string[], scopes: PluginScope[] = []): void {
    this.rows.set(pluginId, { pluginId, ingestRoots, scopes });
  }

  delete(pluginId: string): void {
    this.rows.delete(pluginId);
  }

  findOne = jest.fn(
    ({ where: { pluginId } }: { where: { pluginId: string } }) =>
      Promise.resolve(this.rows.get(pluginId) ?? null),
  );
}

/** Stand-in for `SettingsService`, namespaced exactly like the real table.
 *  `getAll`'s artificial gap forces a real event-loop interleaving between two
 *  concurrent calls — the race a shared mutable variable would not survive. */
class FakeSettings {
  private store = new Map<string, string | null>();

  get = jest.fn((key: string) => Promise.resolve(this.store.get(key) ?? null));
  set = jest.fn((key: string, value: string | null) => {
    this.store.set(key, value);
    return Promise.resolve();
  });
  getAll = jest.fn(async () => {
    await sleep(1);
    return Object.fromEntries(this.store);
  });
}

function makeStack() {
  const registrations = new FakeRegistrationRepo();
  const settings = new FakeSettings();
  const libraryIngestService = {
    ingest: jest.fn().mockResolvedValue({ imported: [] }),
  };
  const countsCache = new PluginCountsCacheService();

  // 19 constructor args, matching `fliks-host.service.ts` exactly — a plain
  // unit build of the real class, same technique as its own spec's harness.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  const host = new (FliksHostImpl as any)(
    null, // core's own frozen default — every real identity comes from bind()
    fakeRepo(), // media
    fakeRepo(), // season
    fakeRepo(), // episode
    fakeRepo(), // mediaFile
    registrations,
    { classifyForSearch: jest.fn() },
    {
      listMovieTargets: jest.fn().mockResolvedValue([]),
      listEpisodeTargets: jest.fn().mockResolvedValue([]),
      groupIntoSeasonPacks: jest.fn().mockResolvedValue([]),
    },
    { resolveAllowedForMedia: jest.fn() },
    { getSizeLimitsMap: jest.fn().mockResolvedValue(new Map()) },
    { scoreRelease: jest.fn() },
    { markInProgress: jest.fn() },
    libraryIngestService,
    { dispatch: jest.fn() },
    { dispatch: jest.fn() },
    settings,
    {
      emit: jest.fn(),
      emitToUsers: jest.fn(),
      emitDomain: jest.fn(),
      emitRaw: jest.fn(),
    },
    { recipientsForMedia: jest.fn().mockResolvedValue([]) },
    countsCache,
  ) as FliksHostImpl;

  const client = new InProcessPluginHostClient(host, new EventsService());
  const binding = new PluginHostBindingService(registrations as any, client);
  return { registrations, settings, libraryIngestService, client, binding };
}

describe('PluginHostBindingService', () => {
  it('keeps config namespaces and ingest roots separate for two plugins served concurrently', async () => {
    const { registrations, settings, libraryIngestService, binding } =
      makeStack();

    const rootAlpha = fs.mkdtempSync(path.join(os.tmpdir(), 'fliks-alpha-'));
    const rootBeta = fs.mkdtempSync(path.join(os.tmpdir(), 'fliks-beta-'));
    const fileAlpha = path.join(rootAlpha, 'movie.mkv');
    const fileBeta = path.join(rootBeta, 'movie.mkv');
    fs.writeFileSync(fileAlpha, 'x');
    fs.writeFileSync(fileBeta, 'x');

    try {
      registrations.seed('test.alpha', [rootAlpha], ['config:rw', 'ingest:write']);
      registrations.seed('test.beta', [rootBeta], ['config:rw', 'ingest:write']);
      await settings.set('plugin.test.alpha.token', 'A-secret');
      await settings.set('plugin.test.beta.token', 'B-secret');

      const alpha = binding.bind('test.alpha');
      const beta = binding.bind('test.beta');

      // Two concurrent, interleaved reads — each must see only its own settings row.
      const [alphaConfig, betaConfig] = await Promise.all([
        alpha['config.get']({ keys: ['token'] }),
        beta['config.get']({ keys: ['token'] }),
      ]);
      expect(alphaConfig).toEqual({ token: 'A-secret' });
      expect(betaConfig).toEqual({ token: 'B-secret' });

      // Each may ingest under its own granted root, concurrently.
      const [alphaIngest, betaIngest] = await Promise.all([
        alpha['library.ingest']({
          idempotencyKey: 'a',
          mediaId: 1,
          paths: [fileAlpha],
          transfer: 'copy',
          sourceLabel: 'A',
        }),
        beta['library.ingest']({
          idempotencyKey: 'b',
          mediaId: 2,
          paths: [fileBeta],
          transfer: 'copy',
          sourceLabel: 'B',
        }),
      ]);
      expect(alphaIngest.imported).toEqual([]);
      expect(betaIngest.imported).toEqual([]);
      expect(libraryIngestService.ingest).toHaveBeenCalledTimes(2);

      // Neither may ingest under the OTHER plugin's root.
      await expect(
        alpha['library.ingest']({
          idempotencyKey: 'c',
          mediaId: 1,
          paths: [fileBeta],
          transfer: 'copy',
          sourceLabel: 'A',
        }),
      ).rejects.toThrow(/outside/);
      await expect(
        beta['library.ingest']({
          idempotencyKey: 'd',
          mediaId: 2,
          paths: [fileAlpha],
          transfer: 'copy',
          sourceLabel: 'B',
        }),
      ).rejects.toThrow(/outside/);
    } finally {
      fs.rmSync(rootAlpha, { recursive: true, force: true });
      fs.rmSync(rootBeta, { recursive: true, force: true });
    }
  });

  it('adversarial: ignores a plugin id smuggled inside the payload — identity comes only from bind()', async () => {
    const { settings, registrations, binding } = makeStack();
    registrations.seed('test.alpha', [], ['config:rw']);
    registrations.seed('test.beta', [], ['config:rw']);

    const alpha = binding.bind('test.alpha');
    const beta = binding.bind('test.beta');

    // No field named `pluginId` exists on `config.set`'s type — this is exactly
    // the shape a compromised or buggy in-process caller could still hand it.
    const spoofed = {
      key: 'shared',
      value: 'from-alpha',
      pluginId: 'test.beta',
    } as unknown as { key: string; value: string | null };
    await alpha['config.set'](spoofed);

    expect(await settings.get('plugin.test.alpha.shared')).toBe('from-alpha');
    expect(await settings.get('plugin.test.beta.shared')).toBeNull();
    expect(await beta['config.get']({ keys: ['shared'] })).toEqual({});
  });

  it('fails closed the instant a registration vanishes, with no collateral on the surviving plugin', async () => {
    const { registrations, client, binding } = makeStack();
    registrations.seed('test.alpha', [], ['config:rw']);
    registrations.seed('test.beta', [], ['config:rw']);

    const alpha = binding.bind('test.alpha');
    const beta = binding.bind('test.beta');
    const clientSpy = jest.spyOn(client, 'config.get');

    await expect(alpha['config.get']({})).resolves.toEqual({});
    await expect(beta['config.get']({})).resolves.toEqual({});

    const callsBefore = clientSpy.mock.calls.length;
    registrations.delete('test.alpha'); // what an uninstall does mid-connection

    await expect(alpha['config.get']({})).rejects.toThrow(
      /no active registration/,
    );
    // Refused before ever reaching the host — not a deeper failure inside it.
    expect(clientSpy.mock.calls.length).toBe(callsBefore);
    await expect(beta['config.get']({})).resolves.toEqual({});
  });

  describe('scope enforcement', () => {
    /** One valid payload per method — just enough for `FliksHostImpl` to run its
     *  fake-backed path without throwing for a reason other than the scope check. */
    const PAYLOADS: { [K in keyof PluginHostApi]: Parameters<PluginHostApi[K]>[0] } = {
      'media.acquisitionContext': { mediaId: 1 },
      'acquisition.candidates': { availableOn: '2024-01-01', limit: 10 },
      'releases.match': { titles: [] },
      'releases.score': { mediaId: 1, releases: [] },
      'media.resolve': {},
      'media.exists': { mediaIds: [] },
      'requests.markInProgress': { idempotencyKey: 'x', mediaId: 1 },
      'library.ingest': {
        idempotencyKey: 'x',
        mediaId: 1,
        paths: [],
        transfer: 'copy',
        sourceLabel: 's',
      },
      'events.publish': [],
      'notifications.dispatch': { event: 'grab.started', payload: {} },
      'counts.set': { key: 'k', value: 1 },
      'events.emitOwn': { type: 't', payload: {}, audience: 'all' },
      'progress.set': { mediaId: 1, ref: 'r', progress: 0, state: 'active' },
      'config.get': {},
      'config.set': { key: 'k', value: 'v' },
    };

    const cases = (Object.keys(HOST_METHOD_SCOPES) as (keyof PluginHostApi)[]).map((method) => ({
      method,
      scopes: HOST_METHOD_SCOPES[method],
      /** The one reported when nothing is granted — the first the filter finds. */
      firstScope: HOST_METHOD_SCOPES[method][0]!,
    }));

    function call(api: PluginHostApi, method: keyof PluginHostApi): Promise<unknown> {
      return (api[method] as (p: unknown) => Promise<unknown>)(PAYLOADS[method]);
    }

    it.each(cases)(
      '$method rejects without $firstScope and passes once every scope it needs is granted',
      async ({ method, scopes, firstScope }) => {
        const { registrations, binding } = makeStack();

        registrations.seed('test.scoped', ['/tmp'], []);
        await expect(call(binding.bind('test.scoped'), method)).rejects.toThrow(
          `missing scope "${firstScope}" required for "${method}"`,
        );

        // Granting all but the last must still refuse: a method needing two is not half-granted.
        if (scopes.length > 1) {
          registrations.seed('test.scoped', ['/tmp'], scopes.slice(0, -1));
          await expect(call(binding.bind('test.scoped'), method)).rejects.toThrow('missing scope');
        }

        registrations.seed('test.scoped', ['/tmp'], [...scopes]);
        await call(binding.bind('test.scoped'), method); // must not reject once granted
      },
    );

    it('a plugin holding only one scope cannot reach a method requiring another', async () => {
      const { registrations, binding } = makeStack();
      registrations.seed('test.narrow', [], ['config:rw']);
      const bound = binding.bind('test.narrow');

      await expect(bound['media.exists']({ mediaIds: [] })).rejects.toThrow(
        'missing scope "media:read" required for "media.exists"',
      );
      await expect(bound['config.get']({})).resolves.toEqual({});
    });
  });
});
