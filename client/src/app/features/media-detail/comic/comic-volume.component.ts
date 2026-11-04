import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, linkedSignal, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucidePencil } from '@lucide/angular';
import { ComicsApiService } from '../../../core/services/api/comics-api.service';
import type { Media } from '../../../core/services/api/media.service';
import type { ComicDetail, ComicIssue, ComicIssuePatch } from '../../../core/services/api/comics.models';
import { AuthService } from '../../../core/services/auth.service';
import { ToastService } from '../../../core/services/toast.service';
import { TvService } from '../../../core/services/tv.service';
import { DetailHeroComponent } from '../../../shared/components/detail-hero/detail-hero';
import { ModalFooterComponent } from '../../../shared/components/modal-footer';
import { ModalHeaderComponent } from '../../../shared/components/modal-header';
import { asComicMedia, nextIssue } from './comic-media';
import { issuePatch, issueReset, volumePatch, volumeReset } from './comic-edit';

/** The page of a comic volume, rendered by the media detail page for the `comic` kind. */
@Component({
  selector: 'app-comic-volume',
  imports: [
    RouterLink,
    DatePipe,
    NgTemplateOutlet,
    TranslatePipe,
    DetailHeroComponent,
    LucidePencil,
    ModalHeaderComponent,
    ModalFooterComponent,
  ],
  templateUrl: './comic-volume.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComicVolumeComponent {
  /** The card handoff (list shape) until the full volume lands. */
  readonly media = input.required<Media>();

  private readonly api = inject(ComicsApiService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly volumeDialog = viewChild<ElementRef<HTMLDialogElement>>('volumeDialog');
  private readonly issueDialog = viewChild<ElementRef<HTMLDialogElement>>('issueDialog');
  /** What the last edit answered: the volume as saved, over the input until the page reloads. */
  private readonly saved = linkedSignal<Media, { comic: ComicDetail; title: string; overview: string | null } | null>({
    source: this.media,
    computation: () => null,
  });

  /** Admin edits are not offered on a TV. */
  private readonly auth = inject(AuthService);
  private readonly tv = inject(TvService);
  protected readonly canEdit = computed(() => !this.tv.isTv() && this.auth.hasPermission('media.edit'));
  protected readonly comic = computed<ComicDetail | null>(() => this.saved()?.comic ?? asComicMedia(this.media())?.comic ?? null);
  protected readonly title = computed(() => this.saved()?.title ?? this.media().title);
  protected readonly overview = computed(() => (this.saved() ? this.saved()!.overview : this.media().overview));
  private readonly issues = computed(() => this.comic()?.issues ?? []);
  protected readonly main = computed(() => this.issues().filter((i) => !i.annual));
  protected readonly annuals = computed(() => this.issues().filter((i) => i.kind === 'annual'));
  protected readonly specials = computed(() => this.issues().filter((i) => i.kind === 'special'));
  protected readonly next = computed(() => nextIssue(this.issues()));
  protected readonly started = computed(() => !!this.next() && this.next()!.progression != null);
  protected readonly readCount = computed(() => this.issues().filter((i) => i.finished).length);
  protected readonly progressPercent = computed(() => (this.issues().length ? (this.readCount() / this.issues().length) * 100 : 0));
  protected readonly progressLabel = computed(() =>
    this.comic() ? this.translate.instant('comic.read_count', { read: this.readCount(), total: this.issues().length }) : null,
  );
  protected readonly editingVolume = signal(false);
  protected readonly editingIssue = signal<ComicIssue | null>(null);
  protected readonly saving = signal(false);
  protected readonly kinds: ComicIssue['kind'][] = ['issue', 'annual', 'special'];

  protected readonly readLink = (itemId: number) => ['/read', this.media().id, itemId];
  protected percent(p: number | null): number {
    return Math.round((p ?? 0) * 100);
  }

  protected openVolume(): void {
    this.editingVolume.set(true);
    this.volumeDialog()?.nativeElement.showModal();
  }

  protected openIssue(i: ComicIssue): void {
    this.editingIssue.set(i);
    this.issueDialog()?.nativeElement.showModal();
  }

  protected closeDialogs(): void {
    this.volumeDialog()?.nativeElement.close();
    this.issueDialog()?.nativeElement.close();
    this.editingVolume.set(false);
    this.editingIssue.set(null);
  }

  protected async saveVolume(e: Event): Promise<void> {
    e.preventDefault();
    const m = this.media();
    const patch = volumePatch(new FormData(e.target as HTMLFormElement), {
      title: this.title(),
      overview: this.overview(),
      comic: this.comic()!,
    });
    await this.run(Object.keys(patch).length === 0, async () => {
      const comic = await this.api.patchVolume(m.id, patch);
      this.saved.set({
        comic,
        title: patch.title ?? this.title(),
        overview: patch.overview !== undefined ? patch.overview : this.overview(),
      });
    });
  }

  protected async saveIssue(e: Event): Promise<void> {
    e.preventDefault();
    const i = this.editingIssue();
    if (!i) return;
    const patch: ComicIssuePatch | 'number' | 'sort' = issuePatch(new FormData(e.target as HTMLFormElement), i);
    if (typeof patch === 'string') {
      this.toast.error(this.translate.instant(`comic.edit.invalid_${patch}`));
      return;
    }
    await this.run(Object.keys(patch).length === 0, async () => {
      const comic = await this.api.patchIssue(i.itemId, patch);
      this.saved.set({ comic, title: this.title(), overview: this.overview() });
    });
  }

  /** Unlocks every field of the dialog: the next scan fills them again. */
  protected async resetVolume(): Promise<void> {
    await this.run(false, async () => {
      const comic = await this.api.patchVolume(this.media().id, volumeReset);
      this.saved.set({ comic, title: this.title(), overview: this.overview() });
    });
  }

  protected async resetIssue(): Promise<void> {
    const i = this.editingIssue();
    if (!i) return;
    await this.run(false, async () => {
      const comic = await this.api.patchIssue(i.itemId, issueReset);
      this.saved.set({ comic, title: this.title(), overview: this.overview() });
    });
  }

  private async run(nothing: boolean, save: () => Promise<void>): Promise<void> {
    if (nothing) {
      this.closeDialogs();
      return;
    }
    this.saving.set(true);
    try {
      await save();
      this.toast.success(this.translate.instant('comic.edit.saved'));
      this.closeDialogs();
    } catch {
      // The global interceptor toasts the failure.
    } finally {
      this.saving.set(false);
    }
  }
}
