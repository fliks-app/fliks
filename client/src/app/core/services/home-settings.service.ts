import { Injectable, inject, signal } from '@angular/core';
import { mergeOrdered } from '../plugin-ui/merge-ordered';
import { TvService } from './tv.service';

/** Stable identity of a home zone. Built-ins are fixed; per-library
 *  "recently added" zones are keyed by their library id. */
export type HomeSectionKey =
  | 'received-recommendations'
  | 'libraries'
  | 'continue-watching'
  | 'recommendations'
  | 'likes'
  | 'recently-added'
  | 'playlists'
  | 'coming-soon'
  | 'requests-recent'
  | `library-recent:${number}`;

export type HomeSectionType =
  | 'received-recommendations'
  | 'libraries'
  | 'continue-watching'
  | 'recommendations'
  | 'likes'
  | 'recently-added'
  | 'playlists'
  | 'coming-soon'
  | 'requests-recent'
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
  'received-recommendations',
  'libraries',
  'continue-watching',
  'recommendations',
  'likes',
  'recently-added',
  'playlists',
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
/** Zones the 10-foot UI does not show. Recent requests is an admin surface
 *  (approve, decline, profile names) the TV layout was never designed for. */
const HIDDEN_ON_TV: ReadonlySet<HomeSectionKey> = new Set<HomeSectionKey>([
  'requests-recent',
]);

@Injectable({ providedIn: 'root' })
export class HomeSettingsService {
  private readonly tv = inject(TvService);
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

  /** Reset zone order + visibility to defaults (built-ins visible in their
   *  canonical order; permission-gated and per-library zones fall back to
   *  their default placement via {@link resolve}). Leaves the recently-added
   *  mode untouched. */
  resetLayout(): void {
    this.persist({
      ...this.settings(),
      order: DEFAULTS.order.map((p) => ({ ...p })),
    });
  }

  /**
   * Reconcile the saved order with what's actually available now: keep the
   * saved order for still-present zones, append any missing built-ins (default
   * visible) in their canonical position, append one zone per library (default
   * hidden — opt-in), and drop entries for libraries that no longer exist.
   */
  resolve(
    libraries: { id: number; name: string }[],
    opts: { requests?: boolean } = {},
  ): ResolvedHomeSection[] {
    const libName = new Map(libraries.map((l) => [l.id, l.name]));
    const available = new Set<HomeSectionKey>(BUILTIN_ORDER);
    if (opts.requests) available.add('requests-recent');
    // The one answer to "which zones exist here", form factor included: the
    // home page renders what this returns and the settings page lists it, so a
    // zone the 10-foot UI hides is not offered for reordering either.
    if (this.tv.isTv()) for (const key of HIDDEN_ON_TV) available.delete(key);
    for (const lib of libraries) {
      available.add(`${LIBRARY_RECENT_PREFIX}${lib.id}` as HomeSectionKey);
    }

    // Saved layouts predating this zone get it on top, not appended at the
    // bottom (new users already get it first via DEFAULTS) — so it's kept
    // out of the generic merge's canonical-order append and handled after.
    const otherBuiltins = DEFAULTS.order.filter((p) => p.key !== 'received-recommendations');
    let merged = mergeOrdered(this.settings().order, otherBuiltins, available, (p) => p.key);
    if (!merged.some((p) => p.key === 'received-recommendations')) {
      merged = [{ key: 'received-recommendations', visible: true }, ...merged];
    }
    // Permission-gated built-in: only offered when the user can use requests.
    // With no saved preference it defaults visible, slotted just above
    // "recently-added"; a saved order (handled above) wins.
    if (available.has('requests-recent') && !merged.some((p) => p.key === 'requests-recent')) {
      const pref: HomeSectionPref = { key: 'requests-recent', visible: true };
      const at = merged.findIndex((p) => p.key === 'recently-added');
      merged = at >= 0 ? [...merged.slice(0, at), pref, ...merged.slice(at)] : [...merged, pref];
    }
    for (const lib of libraries) {
      const key = `${LIBRARY_RECENT_PREFIX}${lib.id}` as HomeSectionKey;
      if (!merged.some((p) => p.key === key)) {
        merged = [...merged, { key, visible: false }];
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
