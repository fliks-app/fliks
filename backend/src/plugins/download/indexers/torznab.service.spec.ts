import axios from 'axios';
import { TorznabService } from './torznab.service';
import { IndexerThrottle } from './indexer-throttle.service';
import { Indexer } from './entities/indexer.entity';

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

function makeService(): TorznabService {
  const statRepo = { create: jest.fn((x: unknown) => x), save: jest.fn().mockResolvedValue(undefined) };
  const indexerRepo = { update: jest.fn().mockResolvedValue(undefined) };
  return new TorznabService(statRepo as never, indexerRepo as never, new IndexerThrottle());
}

/** Same as makeService, but also hands back the indexerRepo mock so callers
 *  can assert refreshCaps actually completed rather than early-returning. */
function makeServiceWithMocks(): { service: TorznabService; indexerRepo: { update: jest.Mock } } {
  const statRepo = { create: jest.fn((x: unknown) => x), save: jest.fn().mockResolvedValue(undefined) };
  const indexerRepo = { update: jest.fn().mockResolvedValue(undefined) };
  const service = new TorznabService(statRepo as never, indexerRepo as never, new IndexerThrottle());
  return { service, indexerRepo };
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
});

describe('TorznabService — refreshCaps endpoint resolution', () => {
  const originalAdapter = axios.defaults.adapter;
  let requestedUrls: string[];

  beforeEach(() => {
    requestedUrls = [];
    axios.defaults.adapter = (config) => {
      requestedUrls.push(String(config.url));
      return Promise.resolve({ data: emptyTorznabBody, status: 200, statusText: 'OK', headers: {}, config }) as never;
    };
  });

  afterEach(() => {
    axios.defaults.adapter = originalAdapter;
  });

  it('still resolves a plain-torznab indexer from its own settings.baseUrl', async () => {
    const { service, indexerRepo } = makeServiceWithMocks();
    const ix = indexer({
      implementation: 'torznab',
      settings: { baseUrl: 'https://legacy.tld/api', apiKey: 'legacy-key' },
    });

    await service.refreshCaps(ix);

    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0].startsWith('https://legacy.tld/api?t=caps')).toBe(true);
    expect(indexerRepo.update).toHaveBeenCalled();
  });

  it('still refreshes caps for a disabled indexer — refreshCaps has no enabled/enableSearch gate', async () => {
    const { service, indexerRepo } = makeServiceWithMocks();
    const ix = indexer({
      enabled: false,
      enableSearch: false,
      settings: { baseUrl: 'https://legacy.tld/api', apiKey: 'k' },
    });

    await service.refreshCaps(ix);

    expect(requestedUrls).toHaveLength(1);
    expect(indexerRepo.update).toHaveBeenCalled();
  });
});

describe('TorznabService — rssSearch endpoint resolution', () => {
  const originalAdapter = axios.defaults.adapter;
  let requestedUrls: string[];

  beforeEach(() => {
    requestedUrls = [];
    axios.defaults.adapter = (config) => {
      requestedUrls.push(String(config.url));
      return Promise.resolve({ data: emptyTorznabBody, status: 200, statusText: 'OK', headers: {}, config }) as never;
    };
  });

  afterEach(() => {
    axios.defaults.adapter = originalAdapter;
  });

  it('still resolves a plain-torznab indexer from its own settings.baseUrl', async () => {
    const { service } = makeServiceWithMocks();
    const ix = indexer({
      implementation: 'torznab',
      settings: { baseUrl: 'https://legacy.tld/api', apiKey: 'legacy-key' },
    });

    const results = await service.rssSearch(ix);

    expect(results).toEqual([]);
    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0].startsWith('https://legacy.tld/api?t=search')).toBe(true);
  });

  it('skips when enableRss is false, even though enabled and enableSearch are true', async () => {
    const { service } = makeServiceWithMocks();
    const ix = indexer({
      enableRss: false,
      settings: { baseUrl: 'https://legacy.tld/api', apiKey: 'k' },
    });

    const results = await service.rssSearch(ix);

    expect(results).toEqual([]);
    expect(requestedUrls).toHaveLength(0);
  });
});

describe('TorznabService — searchMovie gate', () => {
  const originalAdapter = axios.defaults.adapter;
  let requestedUrls: string[];

  beforeEach(() => {
    requestedUrls = [];
    axios.defaults.adapter = (config) => {
      requestedUrls.push(String(config.url));
      return Promise.resolve({ data: emptyTorznabBody, status: 200, statusText: 'OK', headers: {}, config }) as never;
    };
  });

  afterEach(() => {
    axios.defaults.adapter = originalAdapter;
  });

  it('skips when enableSearch is false, even though the indexer is enabled', async () => {
    const { service } = makeServiceWithMocks();
    const ix = indexer({
      enableSearch: false,
      settings: { baseUrl: 'https://legacy.tld/api', apiKey: 'k' },
    });

    const results = await service.searchMovie(ix, 'Some Movie');

    expect(results).toEqual([]);
    expect(requestedUrls).toHaveLength(0);
  });
});
