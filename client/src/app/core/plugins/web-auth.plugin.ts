import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { OidcReturn } from '../services/oidc';

interface WebAuthPlugin {
  /** The iOS auth sheet; resolves with the callback URL, rejects with code `canceled` when dismissed. */
  start(o: { url: string; callbackScheme: string }): Promise<{ url: string }>;
}
const WebAuth = registerPlugin<WebAuthPlugin>('WebAuth');

const SCHEME = 'media.fliks.app';
const CALLBACK_PATH = '/oidc/complete';
/** Android may report the tab closing just before the callback intent arrives. */
const FINISH_GRACE_MS = 500;

/** `code` and `state`, or an error kind, from the callback URL; null for any other URL. */
export function parseOidcCallback(url: string): OidcReturn | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${SCHEME}:` || u.pathname !== CALLBACK_PATH) return null;
  const [code, state, error] = ['code', 'state', 'error'].map((k) => u.searchParams.get(k));
  if (error || !code || !state) return { error: error ?? 'expired' };
  return { code, state };
}

/** Whether this shell can run the sheet: the iOS plugin, or the Custom Tab and app-link plugins on Android. */
export function webAuthAvailable(): boolean {
  return Capacitor.getPlatform() === 'ios'
    ? Capacitor.isPluginAvailable('WebAuth')
    : Capacitor.isPluginAvailable('Browser') && Capacitor.isPluginAvailable('App');
}

/** Sends the user through the system auth sheet; null when they dismiss it. */
export async function webAuthOpen(url: string): Promise<OidcReturn | null> {
  if (Capacitor.getPlatform() === 'ios') {
    try {
      return parseOidcCallback((await WebAuth.start({ url, callbackScheme: SCHEME })).url);
    } catch (e) {
      if ((e as { code?: string }).code === 'canceled') return null;
      throw e;
    }
  }
  let finish!: (r: OidcReturn | null) => void;
  const result = new Promise<OidcReturn | null>((resolve) => (finish = resolve));
  const handles: PluginListenerHandle[] = await Promise.all([
    App.addListener('appUrlOpen', (e) => {
      const r = parseOidcCallback(e.url);
      if (r) finish(r);
    }),
    Browser.addListener('browserFinished', () => setTimeout(() => finish(null), FINISH_GRACE_MS)),
  ]);
  try {
    await Browser.open({ url });
    return await result;
  } finally {
    await Promise.all(handles.map((h) => h.remove()));
  }
}

/** The in-app `/oidc/complete` URL for the callback that cold-started the app (Android killed the process while the tab was up); null when it launched any other way. */
export async function launchCallbackRoute(): Promise<string | null> {
  const launch = await App.getLaunchUrl();
  if (!launch || !parseOidcCallback(launch.url)) return null;
  return `${CALLBACK_PATH}${new URL(launch.url).search}`;
}
