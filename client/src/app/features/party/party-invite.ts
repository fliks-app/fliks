import { Component, ElementRef, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideCopy, LucidePlus, LucideShare2 } from '@lucide/angular';
import { PartyApiService, type PartyDto } from '../../core/services/api/party-api.service';
import { AuthService } from '../../core/services/auth.service';
import { DeviceService } from '../../core/services/device.service';
import { PartyService } from '../../core/services/party/party.service';
import { ModalFooterComponent } from '../../shared/components/modal-footer';
import { ModalHeaderComponent } from '../../shared/components/modal-header';
import { runBusy } from './party-busy';
import { PartyInviteePickerComponent } from './party-invitee-picker';
import { ModalComponent } from '../../shared/components/modal';

/** The host's invite dialog: the link to share, then the followed people to add. A button opens it, or `open()` from a player. */
@Component({
  selector: 'app-party-invite',
  imports: [ModalComponent, TranslatePipe, LucideCopy, LucidePlus, LucideShare2, ModalHeaderComponent, ModalFooterComponent, PartyInviteePickerComponent],
  templateUrl: './party-invite.html',
})
export class PartyInviteComponent {
  private readonly api = inject(PartyApiService);
  protected readonly party = inject(PartyService);
  private readonly device = inject(DeviceService);
  private readonly auth = inject(AuthService);
  private readonly dialog = viewChild.required<string, ElementRef<HTMLDialogElement>>('dialog', { read: ElementRef });

  readonly view = input.required<PartyDto>();
  readonly updated = output<PartyDto>();
  /** False where the host opens the dialog from its own menu. */
  readonly button = input(true);

  protected readonly excluded = computed(() => [this.view().host.userId, ...this.view().guests.map((i) => i.userId)]);
  /** Only the host adds people; a member shares the link. */
  protected readonly host = computed(() => this.view().host.userId === this.auth.user()?.id);
  protected readonly busy = signal(false);
  protected readonly shown = signal(false);
  protected readonly selected = signal<number[]>([]);
  /** The invite link, except on a TV where there is nowhere to share or paste it. */
  protected readonly link = computed(() => (this.device.isTv() ? '' : this.party.inviteLink(this.view().inviteToken)));

  open(): void {
    this.selected.set([]);
    this.shown.set(true);
    this.dialog().nativeElement.showModal();
  }

  protected close(): void {
    this.dialog().nativeElement.close();
  }

  protected async invite(): Promise<void> {
    const ids = this.selected();
    if (!ids.length) return;
    const dto = await runBusy(this.busy, () => this.api.invite(this.view().id, ids));
    if (!dto) return;
    this.updated.emit(dto);
    this.close();
  }
}
