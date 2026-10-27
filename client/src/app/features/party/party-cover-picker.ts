import { ChangeDetectionStrategy, Component, computed, effect, input, model } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import type { PartyCover, PartyCoverChoice, PartyCoverRef } from '../../core/services/api/party-api.service';

export type CoverMode = 'auto' | 'item' | 'mosaic' | 'upload';

/** What the host has picked so far, sent only when it is complete (see `coverValid`). */
export interface CoverDraft {
  mode: CoverMode;
  picked: PartyCoverRef[];
  file: File | null;
}

/** A programme item the cover can be picked from. */
export interface CoverOption {
  mediaId: number;
  episodeId: number | null;
  title: string;
  posterUrl: string | null;
}

/** What saving a draft asks of the server; empty when nothing changed. */
export interface CoverChange {
  patch?: PartyCoverChoice | null;
  upload?: File;
  remove?: true;
}

const MOSAIC_MAX = 4;
export const AUTO_COVER: CoverDraft = { mode: 'auto', picked: [], file: null };

const refOf = (i: { mediaId: number; episodeId: number | null }): PartyCoverRef => ({ mediaId: i.mediaId, ...(i.episodeId != null && { episodeId: i.episodeId }) });

export function draftFromCover(cover: PartyCover): CoverDraft {
  if (cover?.kind === 'item') return { mode: 'item', picked: [refOf(cover.item)], file: null };
  if (cover?.kind === 'mosaic') return { mode: 'mosaic', picked: cover.items.map(refOf), file: null };
  return { ...AUTO_COVER, mode: cover ? 'upload' : 'auto' };
}

export function coverValid(d: CoverDraft): boolean {
  if (d.mode === 'item') return d.picked.length === 1;
  if (d.mode === 'mosaic') return d.picked.length >= 2 && d.picked.length <= MOSAIC_MAX;
  return d.mode !== 'upload' || !!d.file;
}

/** The item or mosaic the draft stands for; null for automatic and upload. */
export function coverChoice(d: CoverDraft): PartyCoverChoice | null {
  if (d.mode === 'item') return { kind: 'item', ...d.picked[0] };
  return d.mode === 'mosaic' ? { kind: 'mosaic', items: d.picked } : null;
}

/** An incomplete draft changes nothing; an upload draft without a file keeps the current upload. */
export function coverChange(from: PartyCover, d: CoverDraft): CoverChange {
  if (!coverValid(d)) return {};
  if (d.mode === 'upload') return d.file ? { upload: d.file } : {};
  const was = draftFromCover(from);
  if (d.mode === was.mode && JSON.stringify(d.picked) === JSON.stringify(was.picked)) return {};
  if (d.mode === 'auto') return was.mode === 'upload' ? { remove: true } : { patch: null };
  return { patch: coverChoice(d) };
}

/** Chooses how a party is pictured: automatic, one programme item, a 2 to 4 item mosaic, or an uploaded image. */
@Component({
  selector: 'app-party-cover-picker',
  imports: [TranslatePipe, ResolveUrlPipe],
  templateUrl: './party-cover-picker.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PartyCoverPickerComponent {
  readonly options = input.required<CoverOption[]>();
  /** The party's cover so far, to preview its upload. */
  readonly current = input<PartyCover>(null);
  readonly draft = model.required<CoverDraft>();

  protected readonly modes: CoverMode[] = ['auto', 'item', 'mosaic', 'upload'];
  protected readonly selectable = computed(() => this.draft().mode === 'item' || this.draft().mode === 'mosaic');
  protected readonly currentUpload = computed(() => {
    const c = this.current();
    return c?.kind === 'upload' ? c.url : null;
  });
  protected readonly preview = computed(() => {
    const f = this.draft().file;
    return f ? URL.createObjectURL(f) : null;
  });

  constructor() {
    effect((onCleanup) => {
      const url = this.preview();
      if (url) onCleanup(() => URL.revokeObjectURL(url));
    });
  }

  protected setMode(mode: CoverMode): void {
    this.draft.update((d) => ({ ...d, mode, picked: mode === 'item' ? d.picked.slice(0, 1) : d.picked }));
  }

  protected isPicked(o: CoverOption): boolean {
    return this.draft().picked.some((p) => p.mediaId === o.mediaId && (p.episodeId ?? null) === o.episodeId);
  }

  protected toggle(o: CoverOption): void {
    const ref = refOf(o);
    this.draft.update((d) => {
      if (d.mode === 'item') return { ...d, picked: [ref] };
      if (this.isPicked(o)) return { ...d, picked: d.picked.filter((p) => p.mediaId !== o.mediaId || (p.episodeId ?? null) !== o.episodeId) };
      return d.picked.length < MOSAIC_MAX ? { ...d, picked: [...d.picked, ref] } : d;
    });
  }

  protected setFile(input: HTMLInputElement): void {
    const file = input.files?.[0];
    if (file?.type.startsWith('image/')) this.draft.update((d) => ({ ...d, file }));
  }
}
