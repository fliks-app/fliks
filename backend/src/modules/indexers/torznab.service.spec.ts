import axios from 'axios';
import { TorznabService } from './torznab.service';
import { IndexerThrottle } from './indexer-throttle.service';
import { Indexer } from './entities/indexer.entity';
import { PluginRegistryService } from '../plugins/plugin-registry.service';
import { buildIndexerImplementationId, type IndexerDescriptor } from '../../common/plugin-contract';

const indexer = (over: Partial<Indexer> = {}): Indexer =>
  ({
    id: 1,
    name: 'test',
    implementation: 'torznab',
    settings: {},
    enableRss: true,
    enableSearch: true,
    priority: 25,
    requestDelay: 0,
    enabled: true,
    capsMovieSearch: false,
    capsTvSearch: false,
    capsSearchFallback: false,
    ...over,
  }) as Indexer;

/** No `<item>`/`<error>` — a valid, empty Torznab response. */
const emptyTorznabBody = '<?xml version="1.0"?><rss><channel></channel></rss>';

function makeService(getIndexerDescriptor: jest.Mock = jest.fn().mockReturnValue(undefined)): TorznabService {
  const statRepo = { create: jest.fn((x: unknown) => x), save: jest.fn().mockResolvedValue(undefined) };
  const indexerRepo = { update: jest.fn().mockResolvedValue(undefined) };
  const registry = { getIndexerDescriptor } as unknown as PluginRegistryService;
  return new TorznabService(statRepo as never, indexerRepo as never, new IndexerThrottle(), registry);
}

describe('TorznabService — search target resolution', () => {
  const originalAdapter = axios.defaults.adapter;
  let requestedUrls: string[];

  beforeEach(() => {
    requestedUrls = [];
    // Stub the network at the adapter level (same approach as http-circuit-breaker.spec.ts)
    // so the real axios request/response pipeline still runs.
    axios.defaults.adapter = (config) => {
      requestedUrls.push(String(config.url));
      return Promise.resolve({ data: emptyTorznabBody, status: 200, statusText: 'OK', headers: {}, config }) as never;
    };
  });

  afterEach(() => {
    axios.defaults.adapter = originalAdapter;
  });

  it('resolves a plain torznab indexer from its own settings.baseUrl, unchanged', async () => {
    const service = makeService();
    const ix = indexer({
      implementation: 'torznab',
      settings: { baseUrl: 'https://legacy.tld/api', apiKey: 'legacy-key' },
    });

    const results = await service.searchMovie(ix, 'Some Movie');

    expect(results).toEqual([]);
    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0].startsWith('https://legacy.tld/api?')).toBe(true);
    expect(requestedUrls[0]).toContain('apikey=legacy-key');
  });

  it('resolves an indexer naming a registered descriptor to the descriptor endpoint, with the user apiKey', async () => {
    const descriptor: IndexerDescriptor = {
      key: 'mytracker',
      name: 'My Tracker',
      driverApi: 'torznab',
      endpoint: 'https://tracker.example/api',
      settings: [],
    };
    const implementation = buildIndexerImplementationId('fliks.test-plugin', 'mytracker');
    const getIndexerDescriptor = jest.fn((id: string) => (id === implementation ? descriptor : undefined));
    const service = makeService(getIndexerDescriptor);
    const ix = indexer({ implementation, settings: { apiKey: 'user-key' } });

    const results = await service.searchMovie(ix, 'Some Movie');

    expect(results).toEqual([]);
    expect(getIndexerDescriptor).toHaveBeenCalledWith(implementation);
    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0].startsWith('https://tracker.example/api?')).toBe(true);
    expect(requestedUrls[0]).toContain('apikey=user-key');
  });

  it('skips an indexer naming an unregistered descriptor, never falling through to raw torznab', async () => {
    const implementation = buildIndexerImplementationId('fliks.uninstalled-plugin', 'sometracker');
    const service = makeService();
    const ix = indexer({ implementation, settings: { apiKey: 'user-key' } });

    const results = await service.searchMovie(ix, 'Some Movie');

    expect(results).toEqual([]);
    expect(requestedUrls).toHaveLength(0);
  });
});
