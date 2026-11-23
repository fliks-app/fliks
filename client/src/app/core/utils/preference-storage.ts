import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { SessionVault } from '../plugins/session-vault.plugin';
import { IS_STANDALONE_BUNDLE } from './standalone-bundle';

const SESSIONS_KEY = 'fliks_sessions';
let vaultMigrated = false;

/** iOS keeps the sessions blob in the Keychain, with no localStorage fallback: a write fallback would put refresh tokens in
 *  backed-up WebKit storage, a read fallback would resurrect a stale copy after logout. */
const inVault = (key: string) => key === SESSIONS_KEY && Capacitor.getPlatform() === 'ios';

/** Moves a leftover localStorage copy into an empty vault, once. A vault failure rejects: it is never read as empty. */
async function readVault(): Promise<string | null> {
  const { value } = await SessionVault.get({ key: SESSIONS_KEY });
  if (vaultMigrated) return value ?? null;
  let legacy: string | null = null;
  try {
    legacy = localStorage.getItem(SESSIONS_KEY);
  } catch {
    /* no localStorage */
  }
  let result = value ?? null;
  if (legacy !== null) {
    if (result === null) {
      await SessionVault.set({ key: SESSIONS_KEY, value: legacy });
      result = legacy;
    }
    try {
      localStorage.removeItem(SESSIONS_KEY);
    } catch {
      /* ignore */
    }
  }
  vaultMigrated = true;
  return result;
}

/** Key/value persistence for state that must survive a restart (server URL, sessions): Capacitor `Preferences` on standalone bundles,
 *  plain localStorage elsewhere and as the fallback. */
export async function readPreference(key: string): Promise<string | null> {
  if (inVault(key)) return readVault();
  if (IS_STANDALONE_BUNDLE) {
    try {
      const { value } = await Preferences.get({ key });
      if (value !== null) return value;
    } catch {
      /* fall through to localStorage */
    }
  }
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Resolves `false` when the value could not be stored — a caller holding the
 *  only other copy of a credential needs to know before dropping it. */
export async function writePreference(key: string, value: string): Promise<boolean> {
  if (inVault(key)) {
    try {
      await SessionVault.set({ key, value });
      return true;
    } catch {
      return false;
    }
  }
  if (IS_STANDALONE_BUNDLE) {
    try {
      await Preferences.set({ key, value });
      return true;
    } catch {
      // A stale Preferences value would shadow the localStorage fallback on read.
      try {
        await Preferences.remove({ key });
      } catch {
        return false;
      }
    }
  }
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export async function removePreference(key: string): Promise<void> {
  if (inVault(key)) {
    await SessionVault.remove({ key });
    return;
  }
  if (IS_STANDALONE_BUNDLE) {
    try {
      await Preferences.remove({ key });
    } catch {
      /* fall through to localStorage */
    }
  }
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
