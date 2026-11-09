import type { MediaType } from '../../../core/enums/media-type.enum';
import type { LibrarySummary } from '../../../core/services/api/libraries-api.service';
import type { TitleKey } from '../../../core/services/api/requests.service';
import type { WantSpec } from '../../../core/services/api/wants-api.service';
import { kindOf } from '../../../core/media-kinds';
import { defaultFolderId } from '../library-folder-select/library-folder-select';

export type AddMode = 'import' | 'request';

/** What a page asks the dialog to add: a provider hit of any kind. */
export interface AddRequest {
  kind: MediaType;
  provider: string;
  externalId: string;
  title: string;
  /** Music: one track of the album is wanted, not the whole album. */
  recording?: { externalId: string; albumExternalId: string };
  /** Defaults to `import` for a caller who can add, else `request`. */
  mode?: AddMode;
  /** A page that shows the choices anyway always opens the dialog. */
  alwaysAsk?: boolean;
  /** What a video request is keyed by, when it is not the provider and id above. */
  titleKey?: TitleKey;
  alreadyRequestedSeasons?: number[];
  preselectedSeasons?: number[];
  profilesLocked?: boolean;
  lockedQualityProfileId?: number | null;
  lockedLanguageProfileId?: number | null;
  /** The editions an active request already covers (books). */
  requestedWants?: WantSpec[];
}

export interface AddResult {
  mode: AddMode;
  mediaId: number | null;
}

export interface Profile {
  id: number;
  name: string;
}

export interface Choices {
  libraries: LibrarySummary[];
  quality: Profile[];
  language: Profile[];
  /** The family of the wants of a book or an album. */
  wantQuality: Profile[];
}

export const compatible = (libs: LibrarySummary[], kind: MediaType): LibrarySummary[] =>
  libs.filter((l) => l.mediaTypes.includes(kind));

const KEY = (kind: MediaType) => `fliks-add-library-${kind}`;

/** The library chosen last time for this kind: a preselection only. */
export function lastLibrary(kind: MediaType): number | null {
  try {
    const n = Number(localStorage.getItem(KEY(kind)));
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function rememberLibrary(kind: MediaType, id: number | null): void {
  try {
    if (id != null) localStorage.setItem(KEY(kind), String(id));
  } catch {
    /* private window or blocked storage: no preselection next time */
  }
}

/** The preselected library: the one chosen last time if it still fits, else the first. */
export function preselect(libs: LibrarySummary[], kind: MediaType): LibrarySummary | null {
  const fit = compatible(libs, kind);
  const last = lastLibrary(kind);
  return fit.find((l) => l.id === last) ?? fit[0] ?? null;
}

/** The library's own profile defaults, else the first profile of each list. */
export function profileDefaults(lib: LibrarySummary | null, c: Choices) {
  return {
    quality: lib?.defaultQualityProfileId ?? c.quality[0]?.id ?? null,
    language: lib?.defaultLanguageProfileId ?? c.language[0]?.id ?? null,
    want: c.wantQuality[0]?.id ?? null,
  };
}

/** Whether the add needs no question: one library takes the kind and nothing else is to be picked. */
export function askNothing(req: AddRequest, c: Choices): boolean {
  if (req.alwaysAsk || kindOf(req.kind).hasSeasons) return false;
  const fit = compatible(c.libraries, req.kind);
  if (fit.length !== 1) return false;
  const d = profileDefaults(fit[0], c);
  if (req.kind === 'movie') return d.quality != null;
  if (req.kind === 'book') return d.want != null;
  if (req.kind === 'album') return !!req.recording && d.want != null;
  return false;
}

export { defaultFolderId };
