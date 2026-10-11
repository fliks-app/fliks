import { Component, ElementRef, computed, inject, output, signal, viewChild } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { COMPANION_IMPORT, CompanionImportType } from '../../../core/constants/companion-import';
import { SUBTITLE_LANGUAGE_CODES } from '../../../core/constants/subtitle-languages';
import { LocalizeLanguagePipe } from '../../../core/pipes/localize-language.pipe';
import { MediaService } from '../../../core/services/api/media.service';
import { SubtitlesApiService } from '../../../core/services/api/subtitles-api.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { DeviceService } from '../../../core/services/device.service';
import { ToastService } from '../../../core/services/toast.service';
import { guessSubtitleTags } from '../../../core/utils/language.utils';
import { serverMessage } from '../../../core/utils/server-message';
import { SelectFieldComponent } from '../forms/select-field/select-field';
import { ToggleFieldComponent } from '../forms/toggle-field/toggle-field';
import { ModalHeaderComponent } from '../modal-header';
import { ModalFooterComponent } from '../modal-footer';

/** Imports a subtitle or an EDL picked on this device next to a media file. */
@Component({
  selector: 'app-companion-import-modal',
  imports: [
    FormsModule,
    TranslatePipe,
    LocalizeLanguagePipe,
    SelectFieldComponent,
    ToggleFieldComponent,
    ModalHeaderComponent,
    ModalFooterComponent,
  ],
  templateUrl: './companion-import-modal.html',
})
export class CompanionImportModalComponent {
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  private readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');
  private readonly device = inject(DeviceService);
  private readonly mediaApi = inject(MediaService);
  private readonly subtitlesApi = inject(SubtitlesApiService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  readonly imported = output<CompanionImportType>();
  readonly languages = SUBTITLE_LANGUAGE_CODES;

  /** Kinds the opener allows, from the caller's permissions. */
  readonly types = signal<readonly CompanionImportType[]>([]);
  readonly type = signal<CompanionImportType>('subtitle');
  readonly language = signal('en');
  readonly forced = signal(false);
  readonly hearingImpaired = signal(false);
  readonly file = signal<File | null>(null);
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);
  readonly accept = computed(() => this.device.filePickerAccept(COMPANION_IMPORT[this.type()].accept));

  private target: { mediaId: number; fileId: number; episodeId?: number } | null = null;

  open(mediaId: number, fileId: number, types: readonly CompanionImportType[], episodeId?: number): void {
    this.target = { mediaId, fileId, episodeId };
    this.types.set(types);
    this.setType(types[0] ?? 'subtitle');
    this.dialog()?.nativeElement.showModal();
  }

  close(): void {
    this.dialog()?.nativeElement.close();
  }

  setType(type: CompanionImportType): void {
    this.type.set(type);
    this.file.set(null);
    this.error.set(null);
    this.applyTags(null);
    const input = this.fileInput()?.nativeElement;
    if (input) input.value = '';
  }

  onPicked(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    this.file.set(file);
    this.error.set(file ? this.precheck(file) : null);
    this.applyTags(file);
  }

  private applyTags(file: File | null): void {
    const tags = file ? guessSubtitleTags(file.name) : null;
    this.language.set(tags?.language ?? 'en');
    this.forced.set(tags?.forced ?? false);
    this.hearingImpaired.set(tags?.hearingImpaired ?? false);
  }

  private precheck(file: File): string | null {
    const rule = COMPANION_IMPORT[this.type()];
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (!(rule.exts as readonly string[]).includes(ext)) return this.translate.instant('file_info.import_err_ext');
    if (file.size > rule.maxBytes) return this.translate.instant('file_info.import_err_too_large');
    return null;
  }

  async submit(): Promise<void> {
    const t = this.target;
    const file = this.file();
    if (!t || !file || this.busy() || this.error()) return;
    this.busy.set(true);
    try {
      if (this.type() === 'subtitle') {
        await this.importSubtitle(t, file);
      } else if (!(await this.importEdl(t, file))) {
        return;
      }
      this.imported.emit(this.type());
      this.close();
    } catch {
      // the global interceptor toasts
    } finally {
      this.busy.set(false);
    }
  }

  private async importSubtitle(t: { mediaId: number; fileId: number; episodeId?: number }, file: File): Promise<void> {
    await this.subtitlesApi.upload(t.mediaId, file, {
      mediaFileId: t.fileId,
      episodeId: t.episodeId,
      language: this.language(),
      forced: this.forced(),
      hearingImpaired: this.hearingImpaired(),
    });
    this.toast.success(this.translate.instant('media_detail.upload_subtitle_success'));
  }

  /** False when the import did not happen (refused, failed or declined). */
  private async importEdl(t: { mediaId: number; fileId: number }, file: File): Promise<boolean> {
    try {
      let res;
      try {
        res = await this.mediaApi.importEdl(t.mediaId, t.fileId, file, false);
      } catch (err) {
        if (!(err instanceof HttpErrorResponse) || err.status !== 409) throw err;
        const ok = await this.confirmation.confirm({
          title: this.translate.instant('common.confirm'),
          message: this.translate.instant('file_info.import_edl_exists'),
          variant: 'warning',
        });
        if (!ok) return false;
        res = await this.mediaApi.importEdl(t.mediaId, t.fileId, file, true);
      }
      const count = res.rejected.length;
      this.toast.success(
        this.translate.instant(count ? 'file_info.import_edl_success_ignored' : 'file_info.import_edl_success', { count }),
      );
      return true;
    } catch (err) {
      this.toast.error(serverMessage(err, this.translate, 'file_info.import_failed'));
      return false;
    }
  }
}
