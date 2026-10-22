import { Preferences } from '@capacitor/preferences';
import { IS_STANDALONE_BUNDLE } from './standalone-bundle';

/** Key/value persistence for state that must survive a restart (server URL, sessions): Capacitor `Preferences` on standalone bundles,
 *  plain localStorage elsewhere and as the fallback. */
export async function readPreference(key: string): Promise<string | null> {
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
