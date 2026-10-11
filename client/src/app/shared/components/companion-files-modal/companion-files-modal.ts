import { NgTemplateOutlet } from '@angular/common';
import { Component, ElementRef, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import {
  LucideCaptions,
  LucideDownload,
  LucideFile,
  LucideFileText,
  LucideImage,
  LucideScissors,
  LucideTrash2,
  LucideUpload,
} from '@lucide/angular';
import { CompanionFile, MediaService } from '../../../core/services/api/media.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { formatBytes } from '../../utils/download-format';
import { ToastService } from '../../../core/services/toast.service';
import { DeviceService } from '../../../core/services/device.service';
import { CompanionImportType } from '../../../core/constants/companion-import';
import { CompanionImportModalComponent } from '../companion-import-modal/companion-import-modal';
import { SelectFieldComponent } from '../forms/select-field/select-field';
import { ModalHeaderComponent } from '../modal-header';
import { ModalFooterComponent } from '../modal-footer';

const KIND_ORDER: CompanionFile['kind'][] = ['subtitle', 'edl', 'nfo', 'image', 'other'];

/** Files on disk linked to one media file, with optional deletion. */
@Component({
  selector: 'app-companion-files-modal',
  imports: [
    TranslatePipe,
    NgTemplateOutlet,
    ModalHeaderComponent,
    ModalFooterComponent,
    LucideCaptions,
    LucideDownload,
    LucideFile,
    LucideFileText,
    LucideImage,
    LucideScissors,
    LucideTrash2,
    LucideUpload,
    CompanionImportModalComponent,
    SelectFieldComponent,
  ],
  templateUrl: './companion-files-modal.html',
})
export class CompanionFilesModalComponent {
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  private readonly api = inject(MediaService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  protected readonly device = inject(DeviceService);
  private readonly importer = viewChild(CompanionImportModalComponent);

  readonly canDelete = input(false);
  readonly canManageSubtitles = input(false);
  readonly canEditMedia = input(false);
  /** Kinds this viewer may import, empty on a device with no file picker. */
  protected readonly importTypes = computed<CompanionImportType[]>(() =>
    this.device.canPickFiles()
      ? [
          ...(this.canManageSubtitles() ? (['subtitle'] as const) : []),
          ...(this.canEditMedia() ? (['edl'] as const) : []),
        ]
      : [],
  );
  readonly items = signal<CompanionFile[]>([]);
  readonly loading = signal(false);
  readonly busy = signal(false);
  /** A tracked subtitle was deleted or imported. */
  readonly subtitlesChanged = output<void>();

  /** '' is All; a kind that vanished after a delete falls back to All. */
  readonly kindFilter = signal('');
  readonly kinds = computed(() => KIND_ORDER.filter((k) => this.items().some((c) => c.kind === k)));
  private readonly activeKind = computed(() => (this.kinds().some((k) => k === this.kindFilter()) ? this.kindFilter() : ''));
  private readonly visible = computed(() => this.items().filter((c) => !this.activeKind() || c.kind === this.activeKind()));

  readonly thisVideo = computed(() => this.visible().filter((c) => c.scope === 'file'));
  readonly folder = computed(() => this.visible().filter((c) => c.scope === 'folder'));
  /** Downloads go through HttpClient and an anchor, which a Capacitor WebView cannot save. */
  protected readonly canDownload = this.device.canSaveFiles;

  private target: { mediaId: number; fileId: number; episodeId?: number } | null = null;

  async open(mediaId: number, fileId: number, episodeId?: number): Promise<void> {
    this.target = { mediaId, fileId, episodeId };
    this.items.set([]);
    this.kindFilter.set('');
    this.dialog()?.nativeElement.showModal();
    await this.refresh();
  }

  close(): void {
    this.dialog()?.nativeElement.close();
  }

  private async refresh(): Promise<void> {
    const t = this.target;
    if (!t) return;
    this.loading.set(true);
    try {
      this.items.set(await this.api.listCompanions(t.mediaId, t.fileId));
    } catch {
      this.items.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  async remove(c: CompanionFile): Promise<void> {
    const t = this.target;
    if (!t || this.busy()) return;
    const confirmed = await this.confirmation.confirm({
      title: this.translate.instant('common.confirm'),
      message: this.confirmMessage(c),
      variant: 'danger',
    });
    if (!confirmed) return;
    this.busy.set(true);
    try {
      await this.api.deleteCompanion(t.mediaId, t.fileId, c.relativePath);
      this.toast.success(this.translate.instant('file_info.companions_deleted'));
      if (c.subtitle?.id != null) this.subtitlesChanged.emit();
    } catch {
      // the global interceptor toasts
    } finally {
      this.busy.set(false);
    }
    await this.refresh();
  }

  async download(c: CompanionFile): Promise<void> {
    const t = this.target;
    if (!t || this.busy()) return;
    this.busy.set(true);
    try {
      await this.api.downloadCompanion(t.mediaId, t.fileId, c);
    } catch {
      // the global interceptor toasts
    } finally {
      this.busy.set(false);
    }
  }

  openImport(): void {
    const t = this.target;
    if (t) this.importer()?.open(t.mediaId, t.fileId, this.importTypes(), t.episodeId);
  }

  async onImported(type: CompanionImportType): Promise<void> {
    if (type === 'subtitle') this.subtitlesChanged.emit();
    await this.refresh();
  }

  private confirmMessage(c: CompanionFile): string {
    const lines = [c.name, this.translate.instant('file_info.companions_consequence_' + c.kind)];
    if (c.hasPair) lines.push(this.translate.instant('file_info.companions_pair_note'));
    if (c.sharedWith.length) lines.push(this.translate.instant('file_info.companions_shared_warning'));
    return lines.join('\n');
  }

  readonly formatSize = formatBytes;

  sharedNames(c: CompanionFile): string {
    return c.sharedWith.map((s) => s.name).join(', ');
  }

  formatDate(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? ''
      : d.toLocaleDateString(this.translate.currentLang() || undefined, {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        });
  }
}
