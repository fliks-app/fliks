import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor, registerPlugin } from '@capacitor/core';

interface WebAuthPlugin {
  /** The iOS auth sheet; resolves with the callback URL, rejects with code `canceled` when dismissed. */
  start(o: { url: string; callbackScheme: string }): Promise<{ url: string }>;
}
const WebAuth = registerPlugin<WebAuthPlugin>('WebAuth');

const SCHEME = 'media.fliks.app';
const CALLBACK_PATH = '/oidc/complete';
/** Android may report the tab closing just before the callback intent arrives. */
const FINISH_GRACE_MS = 500;

/** The callback's query string (`code`, `state` or `error` as sent); null for any other URL. */
export function oidcCallbackQuery(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === `${SCHEME}:` && u.pathname === CALLBACK_PATH ? u.search.slice(1) : null;
  } catch {
    return null;
  }
}

/** Whether this shell can run the sheet: the iOS plugin, or the Custom Tab and app-link plugins on Android. */
export function webAuthAvailable(): boolean {
  return Capacitor.getPlatform() === 'ios'
    ? Capacitor.isPluginAvailable('WebAuth')
    : Capacitor.isPluginAvailable('Browser') && Capacitor.isPluginAvailable('App');
}

/** Sends the user through the system auth sheet. iOS resolves with the callback query; on Android
 *  the app-wide listener gets the callback, so this only resolves null when the tab closes without one. */
export async function webAuthOpen(url: string): Promise<string | null> {
  if (Capacitor.getPlatform() === 'ios') {
    try {
      return oidcCallbackQuery((await WebAuth.start({ url, callbackScheme: SCHEME })).url);
    } catch (e) {
      if ((e as { code?: string }).code === 'canceled') return null;
      throw e;
    }
  }
  let finish!: () => void;
  const closed = new Promise<null>((resolve) => (finish = () => resolve(null)));
  const handle = await Browser.addListener('browserFinished', () => setTimeout(finish, FINISH_GRACE_MS));
  try {
    await Browser.open({ url });
    return await closed;
  } finally {
    await handle.remove();
  }
}

/** Sends every callback URL that carries a pending `state` to `/oidc/complete`; any other is ignored.
 *  Registered once at boot: Capacitor retains an `appUrlOpen` that arrived with no listener. */
export function listenOidcCallbacks(go: (route: string) => void, isPending: (state: string) => boolean): void {
  void App.addListener('appUrlOpen', (e) => {
    const query = oidcCallbackQuery(e.url);
    const state = query && new URLSearchParams(query).get('state');
    if (query && state && isPending(state)) go(`${CALLBACK_PATH}?${query}`);
  });
}
