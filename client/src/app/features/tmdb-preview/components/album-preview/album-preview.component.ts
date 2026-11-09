import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { LucidePlus } from '@lucide/angular';
import { AuthService } from '../../../../core/services/auth.service';
import { mediaDetailLink } from '../../../../core/media-kinds';
import { AddDialogComponent } from '../../../../shared/components/add-dialog/add-dialog';
import type { AddResult } from '../../../../shared/components/add-dialog/add-plan';
import { HeroBaseComponent, type HeroChip } from '../../../../shared/components/hero-base/hero-base';
import { previewPosterName } from '../../../../shared/utils/view-transition';
import { PREVIEW_HOST, type PreviewSeed } from '../../preview-host';

/** The add page of an album: the title and cover of the search hit, and Add, or Request for a user who cannot add. */
@Component({
  selector: 'app-album-preview',
  imports: [TranslatePipe, AddDialogComponent, HeroBaseComponent, LucidePlus],
  templateUrl: './album-preview.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AlbumPreviewComponent implements OnInit {
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly host = inject(PREVIEW_HOST);
  private readonly addDialog = viewChild(AddDialogComponent);

  readonly provider = input.required<string>();
  readonly externalId = input.required<string>();
  readonly seed = input<PreviewSeed | null>(null);

  protected readonly requested = signal(false);
  protected readonly canImport = computed(() => this.auth.hasPermission('media.create'));
  protected readonly canRequest = computed(() => !this.canImport() && this.auth.hasPermission('requests.create'));
  protected readonly chips: HeroChip[] = [{ label: 'kinds.album', cls: 'badge badge-outline badge-sm md:badge-md' }];
  protected readonly posterTransitionName = computed(() => previewPosterName('album', this.provider(), this.externalId()));

  ngOnInit(): void {
    const s = this.seed();
    if (s) this.host.setTitle(s.title);
    this.host.setBackground(s?.posterUrl ?? null, { blur: true });
  }

  protected open(): void {
    void this.addDialog()?.add({
      kind: 'album',
      provider: this.provider(),
      externalId: this.externalId(),
      title: this.seed()?.title ?? '',
      mode: this.canImport() ? 'import' : 'request',
    });
  }

  protected onAdded(r: AddResult): void {
    if (r.mode === 'request') this.requested.set(true);
    else if (r.mediaId != null) void this.router.navigate(mediaDetailLink('album', r.mediaId));
  }
}
