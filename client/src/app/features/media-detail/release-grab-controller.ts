import { Injectable, computed, inject, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { targetFor, type AcquisitionBase, type AcquisitionTarget } from '../../core/acquisition/acquisition';
import { WORK_RELEASES_TITLE_KEY, releasesTitleKey } from '../../core/media-kinds';
import type { Media } from '../../core/services/api/media.service';
import type { Want } from '../../core/services/api/wants-api.service';
import { DownloadProgressService } from '../../core/services/download-progress.service';
import { serverMessage } from '../../core/utils/server-message';
import type { ReleasesModalComponent } from './components/releases-modal/releases-modal.component';
import { MediaDetailReleasePickerService, type MovieRelease } from './media-detail-release-picker.service';
import { isUnprofiledReleaseError, releaseGrabBody } from './media-detail-release.utils';
import { ReleaseSearchStreamService, type IndexerRosterEntry } from './release-search-stream.service';

/** Season / episode a grab targets, matching the leaf its download lands under.
 *  Empty for anything else: a work, a volume, an issue. */
type GrabScope = { seasonNumber?: number; episodeNumber?: number };

/** How long a successful grab keeps the search phase while the download
 *  client's first tick makes its way over SSE. */
const GRAB_HANDOFF_MS = 8000;

const RELEASES_EMPTY = 'media_detail.releases_empty';

/** Identity of a base, for the busy marks: grabs on other targets neither spin nor disable this one. */
export function baseKey(b: AcquisitionBase): string {
  return `${b.kind}:${b.mediaId}:${b.level}:${b.groupId ?? ''}:${b.itemId ?? ''}`;
}

/** The one release search and grab of every kind and level: the list the modal shows, the busy flags and the per-release result marks.
 *  One per detail page (provided by it, so a cached page keeps its own modal and media); a menu under it calls `search` and `grabBest`. */
@Injectable()
export class ReleaseGrabController {
  private readonly api = inject(MediaDetailReleasePickerService);
  private readonly stream = inject(ReleaseSearchStreamService);
  private readonly progress = inject(DownloadProgressService);
  private readonly translate = inject(TranslateService);

  private media: () => Media | null = () => null;
  private modal: () => ReleasesModalComponent | undefined = () => undefined;

  readonly target = signal<AcquisitionTarget | null>(null);
  /** The wants the open modal can aim at; more than one shows the selector. */
  readonly wants = signal<readonly Want[]>([]);
  readonly releases = signal<MovieRelease[]>([]);
  /** Indexers this search queries and where each one is, pushed while it runs. */
  readonly indexers = signal<IndexerRosterEntry[]>([]);
  readonly loading = signal(false);
  readonly searched = signal(false);
  readonly error = signal('');
  readonly emptyMessage = signal(RELEASES_EMPTY);
  readonly grabBusy = signal<string | null>(null);
  readonly grabState = signal<Map<string, 'ok' | 'error'>>(new Map());
  /** Bases with a grab-best in flight. A set, not a flag: the service outlives navigation, so a flag would follow the user to the next title. */
  readonly bestBusy = signal<ReadonlySet<string>>(new Set());

  readonly titleKey = computed(() => {
    const t = this.target();
    return t ? releasesTitleKey(t.kind, t.level) : WORK_RELEASES_TITLE_KEY;
  });
  /** A pack of a group is scored by the plugin alone: the custom-format score means nothing for it. */
  readonly showCfScore = computed(() => this.target()?.level !== 'group');

  attach(media: () => Media | null, modal: () => ReleasesModalComponent | undefined): void {
    this.media = media;
    this.modal = modal;
  }

  isBestBusy(base: AcquisitionBase): boolean {
    return this.bestBusy().has(baseKey(base));
  }

  isSearching(base: AcquisitionBase): boolean {
    const t = this.target();
    return this.loading() && !!t && baseKey(t) === baseKey(base);
  }

  /** Opens the modal on the first want; the selector switches between the rest. */
  async search(base: AcquisitionBase, wants: readonly Want[]): Promise<void> {
    if (!wants.length) return;
    this.wants.set(wants);
    this.modal()?.showModal();
    await this.run(targetFor(base, wants[0]));
  }

  selectWant(want: Want): Promise<void> {
    const t = this.target();
    return t ? this.run(targetFor(t, want)) : Promise.resolve();
  }

  private async run(target: AcquisitionTarget): Promise<void> {
    this.target.set(target);
    this.releases.set([]);
    this.indexers.set([]);
    this.searched.set(false);
    this.error.set('');
    this.emptyMessage.set(RELEASES_EMPTY);
    this.grabState.set(new Map());
    this.loading.set(true);
    try {
      const searches = this.api.providersFor(target).map((p) => ({
        pluginId: p.pluginId,
        name: p.name,
        fetch: (searchId: string) => this.api.search(p.pluginId, target, undefined, searchId),
      }));
      const rows = await this.stream.run(searches, { releases: this.releases, indexers: this.indexers });
      if (this.target() !== target) return;
      this.releases.set(rows);
    } catch (err: unknown) {
      if (this.target() !== target) return;
      this.releases.set([]);
      if (isUnprofiledReleaseError(err)) {
        this.emptyMessage.set('media_detail.no_quality_profile');
      } else {
        this.error.set(serverMessage(err, this.translate, 'media_detail.releases_error'));
      }
    } finally {
      if (this.target() === target) {
        this.searched.set(true);
        this.loading.set(false);
      }
    }
  }

  /** Grabs the best release of every given want at once, picked by the core across every provider; a failure is toasted by the global interceptor. */
  async grabBest(base: AcquisitionBase, wants: readonly Want[]): Promise<void> {
    const key = baseKey(base);
    if (this.bestBusy().has(key) || !wants.length || !this.api.providersFor(base).length) return;
    this.bestBusy.update((s) => new Set(s).add(key));
    try {
      await Promise.allSettled(wants.map((w) => this.withGrabPhase(base, () => this.api.grabBest(targetFor(base, w)))));
    } finally {
      this.bestBusy.update((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  }

  async grabRelease(r: MovieRelease, key: string): Promise<void> {
    const target = this.target();
    const pluginId = r.pluginId ?? (target && this.api.providersFor(target)[0]?.pluginId);
    if (!target || !pluginId) return;
    this.grabBusy.set(key);
    try {
      await this.withGrabPhase(target, () => this.api.grab(pluginId, target, releaseGrabBody(r)));
      this.grabState.update((s) => new Map(s).set(key, 'ok'));
    } catch {
      this.grabState.update((s) => new Map(s).set(key, 'error'));
    } finally {
      this.grabBusy.set(null);
    }
  }

  /** Run a grab with the header badge showing its search phase from the click.
   *  The first progress event hands the badge to the real download; failure clears the phase. */
  private async withGrabPhase<T>(base: AcquisitionBase, run: () => Promise<T>): Promise<T> {
    const release = this.progress.markGrabbing({ mediaId: base.mediaId, mediaType: base.kind, ...this.scopeOf(base) });
    try {
      const out = await run();
      // Keep the phase up until the download client's first SSE tick; only clears a leaf still `searching`.
      setTimeout(release, GRAB_HANDOFF_MS);
      return out;
    } catch (err) {
      release();
      throw err;
    }
  }

  private scopeOf(b: AcquisitionBase): GrabScope {
    if (b.kind !== 'series') return {};
    const seasons = this.media()?.seasons ?? [];
    if (b.level === 'group') {
      const s = seasons.find((x) => x.id === b.groupId);
      return s ? { seasonNumber: s.seasonNumber } : {};
    }
    for (const s of seasons) {
      const ep = s.episodes?.find((e) => e.id === b.itemId);
      if (ep) return { seasonNumber: s.seasonNumber, episodeNumber: ep.episodeNumber };
    }
    return {};
  }
}
