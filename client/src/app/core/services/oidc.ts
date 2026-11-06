/** Helpers of the OpenID Connect login flow (plan section 7.1): PKCE, the per-`state` pending
 *  entries and the platform seam. The calls themselves live in `AuthService`. */
import { Capacitor } from '@capacitor/core';
import { IS_STANDALONE_BUNDLE } from '../utils/standalone-bundle';

export interface OidcProvider {
  id: number;
  name: string;
}

export interface OidcInfo {
  providers: OidcProvider[];
  autoLaunch: number | null;
  passwordLogin: 'everyone' | 'admins';
  /** Origin of `public_url`: where the provider's callback returns to. */
  origin: string;
}

export const NO_OIDC: OidcInfo = { providers: [], autoLaunch: null, passwordLogin: 'everyone', origin: '' };

/** What the callback hands back: the IdP's `code` and our `state`, or an error kind. */
export type OidcReturn = { code: string; state: string } | { error: string };

/** How one shell sends the user to the identity provider and gets the callback back. */
export interface OidcPage {
  title: string;
  message: string;
}

/** What a loopback tab shows: after a callback with a code, and after one that carries an error. */
export interface OidcPages {
  done: OidcPage;
  failed: OidcPage;
}

export interface OidcPlatform {
  /** The `returnTo` the server accepts for this shell; a shell that must listen first opens its listener here. */
  returnTo: string | ((pages: () => OidcPages) => Promise<string>);
  /** Called when `start` fails after `returnTo` resolved, to release what it opened. */
  abort?(): void;
  /** Web leaves the page and resolves never; a shell resolves with the callback query string (`code`
   *  and `state`, or `error`), or null when the user gave up (on Android the app listener gets the callback). */
  open(authorizeUrl: string): Promise<string | null>;
}

/** Whether this shell can run the sheet: the iOS plugin, or the Custom Tab and app-link plugins on Android. */
export function webAuthAvailable(): boolean {
  return Capacitor.getPlatform() === 'ios'
    ? Capacitor.isPluginAvailable('WebAuth')
    : Capacitor.isPluginAvailable('Browser') && Capacitor.isPluginAvailable('App');
}

/** The shell's way to the provider: a loopback listener on desktop, the system auth sheet on the phone
 *  apps, a page redirect on the web. Null hides every SSO button; TVs are hidden through `TvService`. */
export function oidcPlatform(): OidcPlatform | null {
  const desktop = window.fliksDesktop;
  if (desktop) {
    const { oidcListen, oidcWait, oidcCancel } = desktop;
    if (!oidcListen || !oidcWait) return null;
    let id = 0;
    return {
      returnTo: async (pages) => {
        const listener = await oidcListen(pages());
        id = listener.id;
        return `http://127.0.0.1:${listener.port}/oidc`;
      },
      abort: () => void oidcCancel?.(id),
      open: (authorizeUrl) => {
        window.open(authorizeUrl, '_blank');
        return oidcWait(id, new URL(authorizeUrl).searchParams.get('state') ?? '');
      },
    };
  }
  if (Capacitor.isNativePlatform()) {
    if (!webAuthAvailable()) return null;
    return { returnTo: 'app', open: (url) => import('../plugins/web-auth.plugin').then((m) => m.webAuthOpen(url)) };
  }
  if (IS_STANDALONE_BUNDLE) return null;
  // Web Crypto's digest is secure-context only: over plain http the PKCE challenge cannot be made.
  if (!window.isSecureContext) return null;
  return {
    returnTo: 'web',
    open: (authorizeUrl) => {
      // replace, so the browser's back button from the provider page does not re-run an automatic start.
      location.replace(authorizeUrl);
      // Resolves only when the browser restores this page from its back-forward cache.
      return new Promise((resolve) => addEventListener('pageshow', (e) => e.persisted && resolve(null), { once: true }));
    },
  };
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A 32-byte verifier and its S256 challenge. */
export async function newPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

/** A refused or failed sign-in; `kind` is a server error kind (`expired`, `idp`, `not_allowed`...). */
export class OidcError extends Error {
  constructor(readonly kind: string) {
    super(kind);
  }
}

export interface PendingOidc {
  serverUrl: string;
  providerId: number;
  state: string;
  verifier: string;
  link: boolean;
  /** A `prompt=none` re-run: a refusal goes back to the login page without a message. */
  silent: boolean;
  expiresAt: number;
}

export const OIDC_TTL_MS = 10 * 60_000;

/** sessionStorage on web (per tab, like the callback); localStorage on a shell, which survives the process being killed. */
function pendingStore(): Storage {
  return IS_STANDALONE_BUNDLE ? localStorage : sessionStorage;
}

const pendingKey = (state: string) => `fliks.oidc.${state}`;

/** Entries nobody came back for pile up in localStorage on a shell: drop the expired ones. */
function purgeExpired(store: Storage): void {
  for (let i = store.length - 1; i >= 0; i--) {
    const key = store.key(i);
    if (!key?.startsWith('fliks.oidc.') || key === ERROR_AT_KEY || key === LAST_PROVIDER_KEY) continue;
    try {
      if ((JSON.parse(store.getItem(key) ?? '{}') as { expiresAt?: number }).expiresAt! <= Date.now()) {
        store.removeItem(key);
      }
    } catch {
      store.removeItem(key);
    }
  }
}

export function savePending(p: PendingOidc): void {
  try {
    purgeExpired(pendingStore());
    pendingStore().setItem(pendingKey(p.state), JSON.stringify(p));
  } catch {
    /* storage unavailable: the exchange will refuse the state */
  }
}

/** Whether a live entry exists for `state`. */
export function hasPending(state: string): boolean {
  try {
    const raw = pendingStore().getItem(pendingKey(state));
    return !!raw && (JSON.parse(raw) as PendingOidc).expiresAt > Date.now();
  } catch {
    return false;
  }
}

/** The entry for `state`, removed when read; null when unknown or expired. */
export function takePending(state: string): PendingOidc | null {
  try {
    const raw = pendingStore().getItem(pendingKey(state));
    pendingStore().removeItem(pendingKey(state));
    if (!raw) return null;
    const p = JSON.parse(raw) as PendingOidc;
    return p.expiresAt > Date.now() ? p : null;
  } catch {
    return null;
  }
}

const LAST_PROVIDER_KEY = 'fliks.oidcLastProvider';
const ERROR_AT_KEY = 'fliks.oidcErrorAt';
const LOOP_GUARD_MS = 60_000;

function readMap(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(LAST_PROVIDER_KEY) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
}

const accountKey = (serverUrl: string, userId: number) => `${serverUrl}::${userId}`;

/** The provider the last login of this account went through, null after a password login. */
export function lastProvider(serverUrl: string, userId: number): number | null {
  return readMap()[accountKey(serverUrl, userId)] ?? null;
}

export function rememberProvider(serverUrl: string, userId: number, providerId: number | null): void {
  const map = readMap();
  if (providerId === null) delete map[accountKey(serverUrl, userId)];
  else map[accountKey(serverUrl, userId)] = providerId;
  try {
    localStorage.setItem(LAST_PROVIDER_KEY, JSON.stringify(map));
  } catch {
    /* best effort */
  }
}

/** An error or a cancel stops auto-launch and the silent re-run for a minute, and so does a launch
 *  nobody came back from: the browser's back button from the provider page must not start it again. */
export function noteOidcFailure(): void {
  try {
    localStorage.setItem(ERROR_AT_KEY, String(Date.now()));
  } catch {
    /* best effort */
  }
}

const LAUNCH_AT_KEY = 'fliks.oidcLaunchAt';

export function noteOidcLaunch(): void {
  try {
    localStorage.setItem(LAUNCH_AT_KEY, String(Date.now()));
  } catch {
    /* best effort */
  }
}

export function clearOidcLaunch(): void {
  try {
    localStorage.removeItem(LAUNCH_AT_KEY);
  } catch {
    /* best effort */
  }
}

export function recentOidcFailure(): boolean {
  try {
    const since = (key: string) => Date.now() - Number(localStorage.getItem(key) ?? 0);
    return since(ERROR_AT_KEY) < LOOP_GUARD_MS || since(LAUNCH_AT_KEY) < LOOP_GUARD_MS;
  } catch {
    return false;
  }
}

/** The translated text of a server refusal kind; an unknown kind reads as the generic provider error. */
export function oidcErrorText(translate: { instant(key: string): string }, kind: string | null): string {
  if (!kind) return '';
  const key = `oidc.error.${kind}`;
  const text = translate.instant(key);
  return text === key ? translate.instant('oidc.error.idp') : text;
}
