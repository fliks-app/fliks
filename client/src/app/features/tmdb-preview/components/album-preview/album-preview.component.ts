import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucidePlus } from '@lucide/angular';
import { translatePlural } from '../../../../core/pipes/translate-plural.pipe';
import { MusicApiService } from '../../../../core/services/api/music-api.service';
import type { AlbumPreview, AlbumPreviewTrack } from '../../../../core/services/api/music.models';
import { AuthService } from '../../../../core/services/auth.service';
import { mediaDetailLink } from '../../../../core/media-kinds';
import { AddDialogComponent } from '../../../../shared/components/add-dialog/add-dialog';
import type { AddResult } from '../../../../shared/components/add-dialog/add-plan';
import { HeroBaseComponent, type HeroChip } from '../../../../shared/components/hero-base/hero-base';
import { previewPosterName } from '../../../../shared/utils/view-transition';
import { TrackLineComponent } from '../../../music/track-line.component';
import { formatDuration } from '../../../music/music-utils';
import { PREVIEW_HOST, type PreviewSeed } from '../../preview-host';

/** The add page of an album: the hit's title and cover at once, then its artists and tracklist, and Add, or Request for a user who cannot add. */
@Component({
  selector: 'app-album-preview',
  imports: [RouterLink, TranslatePipe, AddDialogComponent, HeroBaseComponent, LucidePlus, TrackLineComponent],
  templateUrl: './album-preview.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AlbumPreviewComponent implements OnInit {
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly host = inject(PREVIEW_HOST);
  private readonly music = inject(MusicApiService);
  private readonly translate = inject(TranslateService);
  private readonly addDialog = viewChild(AddDialogComponent);

  readonly provider = input.required<string>();
  readonly externalId = input.required<string>();
  readonly seed = input<PreviewSeed | null>(null);

  protected readonly album = signal<AlbumPreview | null>(null);
  protected readonly failed = signal(false);
  protected readonly requested = signal(false);
  protected readonly placeholders = [0, 1, 2, 3, 4, 5, 6, 7];
  protected readonly canImport = computed(() => this.auth.hasPermission('media.create'));
  protected readonly canRequest = computed(() => !this.canImport() && this.auth.hasPermission('requests.create'));
  protected readonly chips: HeroChip[] = [{ label: 'kinds.album', cls: 'badge badge-outline badge-sm md:badge-md' }];
  protected readonly posterTransitionName = computed(() => previewPosterName('album', this.provider(), this.externalId()));
  protected readonly hero = computed(() => {
    const a = this.album();
    const s = this.seed();
    const posterUrl = s?.posterUrl ?? a?.posterUrl ?? null;
    return a ? { title: a.title, posterUrl } : s ? { title: s.title, posterUrl } : null;
  });
  protected readonly metaParts = computed(() => {
    const a = this.album();
    if (!a) return [];
    const count = a.trackCount ? translatePlural(this.translate, 'music.track_count', a.trackCount) : '';
    return [a.year ? String(a.year) : '', count, formatDuration(a.durationMs / 1000)].filter(Boolean);
  });
  protected readonly discs = computed(() => {
    const out: { discNumber: number; tracks: AlbumPreviewTrack[] }[] = [];
    for (const t of this.album()?.tracks ?? []) {
      let d = out.find((x) => x.discNumber === t.discNumber);
      if (!d) out.push((d = { discNumber: t.discNumber, tracks: [] }));
      d.tracks.push(t);
    }
    return out;
  });
  protected readonly inLibraryLink = computed(() => {
    const id = this.album()?.existingMediaId;
    return id ? mediaDetailLink('album', id) : null;
  });

  ngOnInit(): void {
    const s = this.seed();
    if (s) this.host.setTitle(s.title);
    this.host.setBackground(s?.posterUrl ?? null, { blur: true });
    void this.load();
  }

  protected async load(): Promise<void> {
    this.failed.set(false);
    try {
      const a = await this.music.albumPreview(this.provider(), this.externalId());
      this.album.set(a);
      this.host.setTitle(a.title);
      if (!this.seed()?.posterUrl) this.host.setBackground(a.posterUrl, { blur: true });
    } catch {
      this.failed.set(true);
    }
  }

  protected async openArtist(externalId: string): Promise<void> {
    try {
      const { id } = await this.music.resolveArtist({ provider: 'musicbrainz', externalId });
      await this.router.navigate(['/artists', id]);
    } catch {
      /* the global error toast says why */
    }
  }

  protected open(): void {
    void this.addDialog()?.add({
      kind: 'album',
      provider: this.provider(),
      externalId: this.externalId(),
      title: this.hero()?.title ?? '',
      mode: this.canImport() ? 'import' : 'request',
    });
  }

  protected onAdded(r: AddResult): void {
    if (r.mode === 'request') this.requested.set(true);
    else if (r.mediaId != null) void this.router.navigate(mediaDetailLink('album', r.mediaId));
  }
}
