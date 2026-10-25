import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { PartyService, type PartyCreateTarget } from '../../core/services/party/party.service';
import { ModalFooterComponent } from '../../shared/components/modal-footer';
import { ModalHeaderComponent } from '../../shared/components/modal-header';
import { PartyInviteePickerComponent } from './party-invitee-picker';

/** `datetime-local` value (local time, minutes) for a date. */
export function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** "Watch together" dialog, mounted once in the layout and opened through `PartyService.createRequest`. */
@Component({
  selector: 'app-party-create-modal',
  imports: [FormsModule, TranslatePipe, ModalHeaderComponent, ModalFooterComponent, PartyInviteePickerComponent],
  templateUrl: './party-create-modal.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PartyCreateModalComponent {
  private readonly party = inject(PartyService);
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly target = signal<PartyCreateTarget | null>(null);
  protected readonly name = signal('');
  protected readonly later = signal(false);
  protected readonly when = signal('');
  protected readonly invitees = signal<number[]>([]);
  protected readonly busy = signal(false);
  protected readonly open = signal(false);
  protected readonly min = signal('');

  constructor() {
    effect(() => {
      const req = this.party.createRequest();
      const dialog = this.dialog();
      if (!req || !dialog) return;
      untracked(() => {
        this.party.createRequest.set(null);
        this.target.set(req);
        this.name.set(req.title);
        this.later.set(false);
        const soon = new Date(Date.now() + 3_600_000);
        soon.setMinutes(0, 0, 0);
        this.when.set(toLocalInput(soon));
        this.min.set(toLocalInput(new Date()));
        this.invitees.set([]);
        this.open.set(true);
        dialog.nativeElement.showModal();
      });
    });
  }

  protected canSubmit(): boolean {
    return !this.busy() && this.name().trim().length > 0 && (!this.later() || !!this.when());
  }

  protected close(): void {
    this.dialog()?.nativeElement.close();
  }

  protected async submit(): Promise<void> {
    const t = this.target();
    if (!t || !this.canSubmit()) return;
    this.busy.set(true);
    try {
      await this.party.create({
        name: this.name().trim(),
        ...(t.playlistId != null
          ? { playlistId: t.playlistId }
          : { mediaId: t.mediaId, mediaFileId: t.mediaFileId, ...(t.episodeId != null && { episodeId: t.episodeId }) }),
        ...(this.later() && { scheduledAt: new Date(this.when()).toISOString() }),
        inviteeIds: this.invitees(),
      });
      this.close();
    } catch {
      /* the error interceptor already toasted it */
    } finally {
      this.busy.set(false);
    }
  }
}
