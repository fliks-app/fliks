import { PluginRouteTable } from './plugin-route-table';
import type { PluginRoute } from '../../../common/plugin-contract';

function route(overrides: Partial<PluginRoute> = {}): PluginRoute {
  return { method: 'GET', path: '/queue', policy: 'read:Media', ...overrides };
}

describe('PluginRouteTable.resolve', () => {
  const queueRoute = route();
  const releaseRoute = route({ path: '/releases/:id', policy: 'grab:Media' });
  const table = new PluginRouteTable([queueRoute, releaseRoute]);

  it('exact hit', () => {
    expect(table.resolve('GET', '/queue')).toEqual({ route: queueRoute, params: {} });
  });

  it('wrong method -> null', () => {
    expect(table.resolve('POST', '/queue')).toBeNull();
  });

  it('unknown path -> null', () => {
    expect(table.resolve('GET', '/unknown')).toBeNull();
  });

  it('trailing slash still matches (`/queue/` hits `/queue`)', () => {
    expect(table.resolve('GET', '/queue/')).toEqual({ route: queueRoute, params: {} });
  });

  it('`/queue/../admin` does not match `/queue` — `..` is a literal segment, never resolved', () => {
    expect(table.resolve('GET', '/queue/../admin')).toBeNull();
  });

  it('`//queue` (double leading slash) does not match `/queue`', () => {
    expect(table.resolve('GET', '//queue')).toBeNull();
  });

  it('`/QUEUE` matches `/queue` — case-insensitive by default, left as-is (Express behaves the same app-wide)', () => {
    expect(table.resolve('GET', '/QUEUE')).toEqual({ route: queueRoute, params: {} });
  });

  it('a `%2F` inside a param decodes to a literal `/` in the captured value', () => {
    expect(table.resolve('GET', '/releases/40%2Fadmin')).toEqual({
      route: releaseRoute,
      params: { id: '40/admin' },
    });
  });

  it('`..` as a param value is captured happily, not rejected by the route table itself', () => {
    expect(table.resolve('GET', '/releases/..')).toEqual({ route: releaseRoute, params: { id: '..' } });
  });

  it('empty path -> null', () => {
    expect(table.resolve('GET', '')).toBeNull();
  });

  it('a path longer than any declared route -> null', () => {
    expect(table.resolve('GET', '/releases/1/2/3/way/too/long')).toBeNull();
  });

  it('`/releases/:id` is not hit by `/releases/` — an empty param does not match', () => {
    expect(table.resolve('GET', '/releases/')).toBeNull();
  });

  it('method comparison is case-insensitive on the verb only', () => {
    expect(table.resolve('get', '/queue')).toEqual({ route: queueRoute, params: {} });
  });
});
