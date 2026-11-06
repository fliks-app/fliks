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

/** How one shell sends the user to the identity provider and gets `code` and `state` back. */
export interface OidcPlatform {
  /** The `returnTo` the server accepts for this shell. */
  returnTo: string;
  /** Web leaves the page and resolves never; shells with an auth sheet resolve with the result. */
  open(authorizeUrl: string): Promise<OidcReturn | null>;
}

/** The seam for the phone and desktop PRs: return their platform here (a Capacitor auth plugin,
 *  the desktop loopback bridge) once their bridge is present. Null hides every SSO button. */
export function oidcPlatform(): OidcPlatform | null {
  if (Capacitor.isNativePlatform() || IS_STANDALONE_BUNDLE || window.fliksDesktop) return null;
  return {
    returnTo: 'web',
    open: (authorizeUrl) => {
      location.assign(authorizeUrl);
      return new Promise(() => undefined);
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
  constructor(
    readonly kind: string,
    readonly pending: PendingOidc | null = null,
  ) {
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

export function savePending(p: PendingOidc): void {
  try {
    pendingStore().setItem(pendingKey(p.state), JSON.stringify(p));
  } catch {
    /* storage unavailable: the exchange will refuse the state */
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

/** The provider the last login on this server went through, null after a password login. */
export function lastProvider(serverUrl: string): number | null {
  return readMap()[serverUrl] ?? null;
}

export function rememberProvider(serverUrl: string, providerId: number | null): void {
  const map = readMap();
  if (providerId === null) delete map[serverUrl];
  else map[serverUrl] = providerId;
  try {
    localStorage.setItem(LAST_PROVIDER_KEY, JSON.stringify(map));
  } catch {
    /* best effort */
  }
}

/** An error or a cancel stops auto-launch and the silent re-run for a minute. */
export function noteOidcFailure(): void {
  try {
    localStorage.setItem(ERROR_AT_KEY, String(Date.now()));
  } catch {
    /* best effort */
  }
}

export function recentOidcFailure(): boolean {
  try {
    return Date.now() - Number(localStorage.getItem(ERROR_AT_KEY) ?? 0) < LOOP_GUARD_MS;
  } catch {
    return false;
  }
}
