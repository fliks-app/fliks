import { listenOidcCallbacks, oidcCallbackQuery, webAuthAvailable, webAuthOpen } from './web-auth.plugin';
import { oidcPlatform } from '../services/oidc';

const m = vi.hoisted(() => ({
  platform: 'ios',
  plugins: new Set<string>(),
  start: vi.fn(),
  open: vi.fn(),
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
    m.listeners = {};
    m.removed = [];
  });

  it('extracts the callback query and ignores other URLs', () => {
    expect(oidcCallbackQuery(`${CB}?code=c&state=s`)).toBe('code=c&state=s');
    expect(oidcCallbackQuery(`${CB}?error=idp&state=s`)).toBe('error=idp&state=s');
    expect(oidcCallbackQuery('media.fliks.app:/other?code=c&state=s')).toBeNull();
    expect(oidcCallbackQuery('https://x.test/oidc/complete?code=c&state=s')).toBeNull();
    expect(oidcCallbackQuery('not a url')).toBeNull();
  });

  describe('iOS', () => {
    it('resolves with the callback query of the auth sheet', async () => {
      m.start.mockResolvedValue({ url: `${CB}?code=c&state=s` });
      expect(await webAuthOpen('https://idp.test/auth')).toBe('code=c&state=s');
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

    it('only reports a cancel when the tab closes, and drops its listener', async () => {
      const p = webAuthOpen('https://idp.test/auth');
      await vi.waitFor(() => expect(m.open).toHaveBeenCalledWith({ url: 'https://idp.test/auth' }));
      expect(m.listeners['appUrlOpen']).toBeUndefined();
      m.listeners['browserFinished']({});
      expect(await p).toBeNull();
      expect(m.removed).toEqual(['browserFinished']);
    });
  });

  describe('app-wide callback listener', () => {
    it('routes a callback of a pending state to /oidc/complete, whatever started it', async () => {
      const go = vi.fn();
      listenOidcCallbacks(go, (s) => s === 's', () => true);
      await vi.waitFor(() => expect(m.listeners['appUrlOpen']).toBeDefined());
      m.listeners['appUrlOpen']({ url: `${CB}?code=c&state=s` });
      m.listeners['appUrlOpen']({ url: `${CB}?error=idp&state=s` });
      expect(go.mock.calls).toEqual([['/oidc/complete?code=c&state=s'], ['/oidc/complete?error=idp&state=s']]);
    });

    it('ignores a forged state, a stateless callback and a foreign URL while signed in', async () => {
      const go = vi.fn();
      listenOidcCallbacks(go, (s) => s === 's', () => true);
      await vi.waitFor(() => expect(m.listeners['appUrlOpen']).toBeDefined());
      m.listeners['appUrlOpen']({ url: `${CB}?code=x&state=forged` });
      m.listeners['appUrlOpen']({ url: `${CB}?code=x` });
      m.listeners['appUrlOpen']({ url: 'https://fliks.test/x?state=s' });
      expect(go).not.toHaveBeenCalled();
    });

    it('shows the expired error for a forged or stateless callback when nobody is signed in', async () => {
      const go = vi.fn();
      listenOidcCallbacks(go, (s) => s === 's', () => false);
      await vi.waitFor(() => expect(m.listeners['appUrlOpen']).toBeDefined());
      m.listeners['appUrlOpen']({ url: `${CB}?code=x&state=forged` });
      m.listeners['appUrlOpen']({ url: `${CB}?code=x` });
      m.listeners['appUrlOpen']({ url: 'https://fliks.test/x?state=s' });
      expect(go.mock.calls).toEqual([['/oidc/complete?code=x&state=forged'], ['/oidc/complete?code=x']]);
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
});
