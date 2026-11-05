import { Injectable, inject, signal } from '@angular/core';
import type { MediaType } from '../enums/media-type.enum';
import type { AcquisitionLevel } from '../media-kinds';
import { WantsApiService, type Want } from '../services/api/wants-api.service';
import type { WhenContext } from '../plugin-ui/when-evaluator';

/** What a release search or grab is about, short of the want it aims at. */
export interface AcquisitionBase {
  mediaId: number;
  kind: MediaType;
  level: AcquisitionLevel;
  /** `item_groups.id` of the season, volume or disc, at the `group` level. */
  groupId?: number | null;
  /** `items.id` of the episode, issue or track, at the `item` level. */
  itemId?: number | null;
}

/** A base aimed at one want: the pair the release picker routes take. */
export interface AcquisitionTarget extends AcquisitionBase {
  family: Want['family'];
  language?: string | null;
}

/** Facts of one detail page the plugin menus read, whatever the kind. */
export interface AcquisitionContext {
  level: AcquisitionLevel;
  wants: readonly Want[];
  hasFiles: boolean;
  identified: boolean;
}

/** `hasQualityProfile`: at least one want carries a profile (`wants-follows.md` rule 2b). */
export function acquirable(wants: readonly Want[]): boolean {
  return wants.some((w) => w.qualityProfileId != null);
}

/** The wants an acquisition aims at: the unsatisfied ones of a work when there are any, else every profiled want.
 *  A group or an item is not tracked by its work's want, so it never filters on satisfaction. */
export function aimedWants(ctx: Pick<AcquisitionContext, 'level' | 'wants'>): Want[] {
  const profiled = ctx.wants.filter((w) => w.qualityProfileId != null);
  const open = profiled.filter((w) => !w.satisfied);
  return ctx.level === 'work' && open.length ? open : profiled;
}

export function targetFor(base: AcquisitionBase, want: Pick<Want, 'family' | 'language'>): AcquisitionTarget {
  return { ...base, family: want.family, language: want.language };
}

/** The slice of the `when` vocabulary the acquisition context answers. */
export function acquisitionWhen(ctx: AcquisitionContext, kind: MediaType): Partial<WhenContext> {
  return {
    mediaType: kind,
    hasFiles: ctx.hasFiles,
    hasQualityProfile: acquirable(ctx.wants),
    identified: ctx.identified,
    level: ctx.level,
    isEpisode: ctx.level === 'item' && kind === 'series',
  };
}

/** The wants of the titles shown, shared by every menu of the page; the page reloads them when its media refreshes. */
@Injectable({ providedIn: 'root' })
export class WantsStore {
  private readonly api = inject(WantsApiService);
  private readonly byMedia = signal<ReadonlyMap<number, readonly Want[]>>(new Map());

  wantsOf(mediaId: number): readonly Want[] {
    return this.byMedia().get(mediaId) ?? [];
  }

  set(mediaId: number, wants: readonly Want[]): void {
    this.byMedia.update((m) => new Map(m).set(mediaId, wants));
  }

  /** Fetches the wants again; a failure leaves what was known, or none, which hides the acquisition rows. */
  async load(mediaId: number): Promise<void> {
    try {
      this.set(mediaId, await this.api.wants(mediaId));
    } catch {
      /* keeps the previous wants */
    }
  }
}
