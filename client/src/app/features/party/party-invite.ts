import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LucidePlus } from '@lucide/angular';
import { PartyApiService, type PartyDto } from '../../core/services/api/party-api.service';
import { ModalFooterComponent } from '../../shared/components/modal-footer';
import { ModalHeaderComponent } from '../../shared/components/modal-header';
import { runBusy } from './party-busy';
import { PartyInviteePickerComponent } from './party-invitee-picker';

/** The host's "invite more people" button and dialog for a scheduled party. */
@Component({
  selector: 'app-party-invite',
  imports: [TranslatePipe, LucidePlus, ModalHeaderComponent, ModalFooterComponent, PartyInviteePickerComponent],
  templateUrl: './party-invite.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PartyInviteComponent {
  private readonly api = inject(PartyApiService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  readonly view = input.required<PartyDto>();
  readonly updated = output<PartyDto>();

  protected readonly excluded = computed(() => [this.view().host.userId, ...this.view().guests.map((i) => i.userId)]);
  protected readonly busy = signal(false);
  protected readonly open = signal(false);
  protected readonly selected = signal<number[]>([]);

  protected show(): void {
    this.selected.set([]);
    this.open.set(true);
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
