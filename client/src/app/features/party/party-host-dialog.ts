import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { PartyApiService, type PartyDto, type PartySwitches } from '../../core/services/api/party-api.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { KeyboardOverlayService } from '../../core/services/keyboard-overlay.service';
import { ModalFooterComponent } from '../../shared/components/modal-footer';
import { ModalHeaderComponent } from '../../shared/components/modal-header';
import { TvRowDirective } from '../../shared/directives/tv-row.directive';
import { PartyHostSwitchesComponent, switchesPatch } from '../player/party/party-host-switches';
import { runBusy } from './party-busy';
import { AUTO_COVER, PartyCoverPickerComponent, coverChange, draftFromCover, type CoverDraft, type CoverOption } from './party-cover-picker';
import { itemThumb } from './party-thumb';
import { toLocalInput } from './party-create-modal';
import { partyWhen } from './party-time';

/** The host's settings for a party, opened from its page. */
@Component({
  selector: 'app-party-host-dialog',
  imports: [FormsModule, TranslatePipe, ModalHeaderComponent, ModalFooterComponent, PartyHostSwitchesComponent, PartyCoverPickerComponent, TvRowDirective],
  templateUrl: './party-host-dialog.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PartyHostDialogComponent {
  private readonly api = inject(PartyApiService);
  private readonly confirm = inject(ConfirmationService);
  private readonly translate = inject(TranslateService);
  protected readonly keyboard = inject(KeyboardOverlayService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  readonly view = input.required<PartyDto>();
  readonly link = input.required<string>();
  /** The snapshot the server returned after a change. */
  readonly updated = output<PartyDto>();

  protected readonly busy = signal(false);
  protected readonly min = signal('');
  protected readonly newWhen = signal('');
  protected readonly draft = signal<PartySwitches>({ policy: 'everyone', reactionsEnabled: true, chatEnabled: true, linkSharing: true, public: false });
  protected readonly cover = signal<CoverDraft>(AUTO_COVER);
  protected readonly coverOptions = signal<CoverOption[]>([]);
  private readonly coverDiff = computed(() => coverChange(this.view().cover, this.cover()));
  private readonly patch = computed(() => switchesPatch(this.view(), this.draft()));
  private readonly newAt = computed(() => {
    const was = this.view().scheduledAt;
    if (!this.newWhen() || (was && this.newWhen() === toLocalInput(new Date(was)))) return null;
    return new Date(this.newWhen()).toISOString();
  });
  protected readonly dirty = computed(() => Object.keys(this.patch()).length > 0 || this.newAt() !== null || Object.keys(this.coverDiff()).length > 0);

  show(): void {
    const v = this.view();
    this.draft.set({ policy: v.policy, reactionsEnabled: v.reactionsEnabled, chatEnabled: v.chatEnabled, linkSharing: v.linkSharing, public: v.public });
    this.newWhen.set(v.scheduledAt ? toLocalInput(new Date(v.scheduledAt)) : '');
    this.min.set(toLocalInput(new Date()));
    this.cover.set(draftFromCover(v.cover));
    this.coverOptions.set([]);
    void this.api.queue(v.id, true).then(
      (items) =>
      this.coverOptions.set(items.filter((i) => !i.hidden).map((i) => ({ mediaId: i.mediaId, episodeId: i.episodeId, title: i.episodeId != null ? (i.seriesTitle ?? i.title) : i.title, posterUrl: itemThumb(i).url }))),
    );
    this.dialog().nativeElement.showModal();
  }

  protected close(): void {
    this.dialog().nativeElement.close();
  }

  protected async save(): Promise<void> {
    const at = this.newAt();
    if (at) {
      const ok = await this.confirm.confirm({
        title: this.translate.instant('party.reschedule_title'),
        message: this.translate.instant('party.reschedule_message', { name: this.view().name, when: partyWhen(at, this.translate, Date.now()) }),
        confirmLabel: this.translate.instant('party.reschedule'),
      });
      if (!ok) return;
    }
    const id = this.view().id;
    const { patch, upload, remove } = this.coverDiff();
    const body = { ...this.patch(), ...(at && { scheduledAt: at }), ...(patch !== undefined && { cover: patch }) };
    const dto = await runBusy(this.busy, async () => {
      let dto = Object.keys(body).length ? await this.api.update(id, body) : this.view();
      if (upload) dto = await this.api.uploadCover(id, upload);
      if (remove) dto = await this.api.removeCover(id);
      return dto;
    });
    if (!dto) return;
    this.updated.emit(dto);
    this.close();
  }

  protected async regenerate(): Promise<void> {
    const ok = await this.confirm.confirm({
      title: this.translate.instant('party.regenerate_title'),
      message: this.translate.instant('party.regenerate_message'),
      confirmLabel: this.translate.instant('party.regenerate_link'),
      variant: 'warning',
    });
    if (!ok) return;
    const dto = await runBusy(this.busy, () => this.api.update(this.view().id, { regenerateToken: true }));
    if (dto) this.updated.emit(dto);
  }
}
