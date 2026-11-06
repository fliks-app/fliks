import { launchCallbackRoute, parseOidcCallback, webAuthAvailable, webAuthOpen } from './web-auth.plugin';
import { oidcPlatform } from '../services/oidc';

const m = vi.hoisted(() => ({
  platform: 'ios',
  plugins: new Set<string>(),
  start: vi.fn(),
  open: vi.fn(),
  launchUrl: vi.fn(),
  listeners: {} as Record<string, (e: unknown) => void>,
  removed: [] as string[],
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => m.platform !== 'web',
    getPlatform: () => m.platform,
    isPluginAvailable: (n: string) => m.plugins.has(n),
  },
  registerPlugin: () => ({ start: m.start }),
}));
vi.mock('@capacitor/browser', () => ({
  Browser: {
    open: m.open,
    addListener: async (n: string, fn: (e: unknown) => void) => {
      m.listeners[n] = fn;
      return { remove: async () => void m.removed.push(n) };
    },
  },
}));
vi.mock('@capacitor/app', () => ({
  App: {
    getLaunchUrl: m.launchUrl,
    addListener: async (n: string, fn: (e: unknown) => void) => {
      m.listeners[n] = fn;
      return { remove: async () => void m.removed.push(n) };
    },
  },
}));

const CB = 'media.fliks.app:/oidc/complete';

describe('web-auth plugin', () => {
  beforeEach(() => {
    m.platform = 'ios';
    m.plugins = new Set();
    m.start.mockReset();
    m.open.mockReset().mockResolvedValue(undefined);
    m.launchUrl.mockReset();
    m.listeners = {};
    m.removed = [];
  });

  it('parses a code, an error, and ignores other URLs', () => {
    expect(parseOidcCallback(`${CB}?code=c&state=s`)).toEqual({ code: 'c', state: 's' });
    expect(parseOidcCallback(`${CB}?error=idp&state=s`)).toEqual({ error: 'idp' });
    expect(parseOidcCallback(`${CB}?state=s`)).toEqual({ error: 'expired' });
    expect(parseOidcCallback('media.fliks.app:/other?code=c&state=s')).toBeNull();
    expect(parseOidcCallback('https://x.test/oidc/complete?code=c&state=s')).toBeNull();
    expect(parseOidcCallback('not a url')).toBeNull();
  });

  describe('iOS', () => {
    it('resolves with the callback of the auth sheet', async () => {
      m.start.mockResolvedValue({ url: `${CB}?code=c&state=s` });
      expect(await webAuthOpen('https://idp.test/auth')).toEqual({ code: 'c', state: 's' });
      expect(m.start).toHaveBeenCalledWith({ url: 'https://idp.test/auth', callbackScheme: 'media.fliks.app' });
    });

    it('resolves null when the sheet is dismissed and rethrows other failures', async () => {
      m.start.mockRejectedValueOnce({ code: 'canceled' });
      expect(await webAuthOpen('u')).toBeNull();
      m.start.mockRejectedValueOnce(new Error('boom'));
      await expect(webAuthOpen('u')).rejects.toThrow('boom');
    });
  });

  describe('Android', () => {
    beforeEach(() => (m.platform = 'android'));

    it('resolves on appUrlOpen for the callback and drops its listeners', async () => {
      const p = webAuthOpen('https://idp.test/auth');
      await vi.waitFor(() => expect(m.open).toHaveBeenCalledWith({ url: 'https://idp.test/auth' }));
      m.listeners['appUrlOpen']({ url: 'media.fliks.app:/elsewhere?code=x&state=y' });
      m.listeners['appUrlOpen']({ url: `${CB}?code=c&state=s` });
      expect(await p).toEqual({ code: 'c', state: 's' });
      expect(m.removed.sort()).toEqual(['appUrlOpen', 'browserFinished']);
    });

    it('resolves null when the tab closes without a callback', async () => {
      const p = webAuthOpen('u');
      await vi.waitFor(() => expect(m.open).toHaveBeenCalled());
      m.listeners['browserFinished']({});
      expect(await p).toBeNull();
    });

    it('lets a callback that follows the tab closing win', async () => {
      const p = webAuthOpen('u');
      await vi.waitFor(() => expect(m.open).toHaveBeenCalled());
      m.listeners['browserFinished']({});
      m.listeners['appUrlOpen']({ url: `${CB}?code=c&state=s` });
      expect(await p).toEqual({ code: 'c', state: 's' });
    });
  });

  describe('platform selection', () => {
    it('uses the auth sheet on iOS only with the plugin', () => {
      expect(oidcPlatform()).toBeNull();
      m.plugins.add('WebAuth');
      expect(webAuthAvailable()).toBe(true);
      expect(oidcPlatform()).toMatchObject({ returnTo: 'app' });
    });

    it('needs the Custom Tab and app plugins on Android', () => {
      m.platform = 'android';
      m.plugins.add('Browser');
      expect(oidcPlatform()).toBeNull();
      m.plugins.add('App');
      expect(oidcPlatform()).toMatchObject({ returnTo: 'app' });
    });
  });

  describe('cold start', () => {
    it('routes the launch callback to /oidc/complete with its query', async () => {
      m.launchUrl.mockResolvedValue({ url: `${CB}?code=c&state=s` });
      expect(await launchCallbackRoute()).toBe('/oidc/complete?code=c&state=s');
    });

    it('ignores a normal launch and a foreign URL', async () => {
      m.launchUrl.mockResolvedValueOnce(undefined);
      expect(await launchCallbackRoute()).toBeNull();
      m.launchUrl.mockResolvedValueOnce({ url: 'https://fliks.test/x' });
      expect(await launchCallbackRoute()).toBeNull();
    });
  });
});
