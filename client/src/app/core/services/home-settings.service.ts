import { Injectable, signal } from '@angular/core';

/** Stable identity of a home zone. Built-ins are fixed; per-library
 *  "recently added" zones are keyed by their library id. */
export type HomeSectionKey =
  | 'libraries'
  | 'continue-watching'
  | 'recommendations'
  | 'recently-added'
  | 'coming-soon'
  | `library-recent:${number}`;

export type HomeSectionType =
  | 'libraries'
  | 'continue-watching'
  | 'recommendations'
  | 'recently-added'
  | 'coming-soon'
  | 'library-recent';

/** What the "Recently added" zones rank by — must match the backend
 *  `RecentlyAddedMode`. */
export type RecentlyAddedMode = 'media' | 'file' | 'both';

export interface HomeSectionPref {
  key: HomeSectionKey;
  visible: boolean;
}

export interface ResolvedHomeSection {
  key: HomeSectionKey;
  type: HomeSectionType;
  visible: boolean;
  libraryId?: number;
  libraryName?: string;
}

export interface HomeSettings {
  order: HomeSectionPref[];
  recentlyAddedMode: RecentlyAddedMode;
}

const STORAGE_KEY = 'home.settings';
const LIBRARY_RECENT_PREFIX = 'library-recent:';

const BUILTIN_ORDER: HomeSectionKey[] = [
  'libraries',
  'continue-watching',
  'recommendations',
  'recently-added',
  'coming-soon',
];

const DEFAULTS: HomeSettings = {
  order: BUILTIN_ORDER.map((key) => ({ key, visible: true })),
  recentlyAddedMode: 'file',
};

/**
 * Per-user, per-device home personalization (zone visibility + order and the
 * "recently added" ranking mode), persisted to localStorage exactly like
 * `DisplaySettingsService` / `PlayerSettingsService`. No backend involvement.
 */
@Injectable({ providedIn: 'root' })
export class HomeSettingsService {
  readonly settings = signal<HomeSettings>(this.load());

  private load(): HomeSettings {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<HomeSettings>;
        return {
          order: Array.isArray(parsed.order) ? parsed.order : DEFAULTS.order,
          recentlyAddedMode: parsed.recentlyAddedMode ?? DEFAULTS.recentlyAddedMode,
        };
      }
    } catch {
      /* private mode / corrupt value */
    }
    return { order: [...DEFAULTS.order], recentlyAddedMode: DEFAULTS.recentlyAddedMode };
  }

  private persist(next: HomeSettings): void {
    this.settings.set(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* private mode / SSR */
    }
  }

  /** Persist the full ordered list of prefs (the settings page rebuilds it
   *  from the rendered rows on every reorder/toggle). */
  setOrder(order: HomeSectionPref[]): void {
    this.persist({ ...this.settings(), order });
  }

  setMode(recentlyAddedMode: RecentlyAddedMode): void {
    this.persist({ ...this.settings(), recentlyAddedMode });
  }

  /**
   * Reconcile the saved order with what's actually available now: keep the
   * saved order for still-present zones, append any missing built-ins (default
   * visible) in their canonical position, append one zone per library (default
   * hidden — opt-in), and drop entries for libraries that no longer exist.
   */
  resolve(libraries: { id: number; name: string }[]): ResolvedHomeSection[] {
    const libName = new Map(libraries.map((l) => [l.id, l.name]));
    const available = new Set<HomeSectionKey>(BUILTIN_ORDER);
    for (const lib of libraries) {
      available.add(`${LIBRARY_RECENT_PREFIX}${lib.id}` as HomeSectionKey);
    }

    const seen = new Set<HomeSectionKey>();
    const merged: HomeSectionPref[] = [];
    for (const pref of this.settings().order) {
      if (available.has(pref.key) && !seen.has(pref.key)) {
        merged.push(pref);
        seen.add(pref.key);
      }
    }
    for (const key of BUILTIN_ORDER) {
      if (!seen.has(key)) {
        merged.push({ key, visible: true });
        seen.add(key);
      }
    }
    for (const lib of libraries) {
      const key = `${LIBRARY_RECENT_PREFIX}${lib.id}` as HomeSectionKey;
      if (!seen.has(key)) {
        merged.push({ key, visible: false });
        seen.add(key);
      }
    }

    return merged.map((pref) => this.describe(pref, libName));
  }

  private describe(
    pref: HomeSectionPref,
    libName: Map<number, string>,
  ): ResolvedHomeSection {
    if (pref.key.startsWith(LIBRARY_RECENT_PREFIX)) {
      const libraryId = Number(pref.key.slice(LIBRARY_RECENT_PREFIX.length));
      return {
        key: pref.key,
        type: 'library-recent',
        visible: pref.visible,
        libraryId,
        libraryName: libName.get(libraryId),
      };
    }
    return {
      key: pref.key,
      type: pref.key as HomeSectionType,
      visible: pref.visible,
    };
  }
}
