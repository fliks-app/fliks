import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { PartyApiService, type PartyDto, type PartySwitches } from '../../core/services/api/party-api.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { KeyboardOverlayService } from '../../core/services/keyboard-overlay.service';
import { PartyService } from '../../core/services/party/party.service';
import { ModalHeaderComponent } from '../../shared/components/modal-header';
import { TvRowDirective } from '../../shared/directives/tv-row.directive';
import { PartyHostSwitchesComponent } from '../player/party/party-host-switches';
import { runBusy } from './party-busy';
import { toLocalInput } from './party-create-modal';
import { PartyInviteePickerComponent } from './party-invitee-picker';
import { partyWhen } from './party-time';

/** The host's settings for a party, opened from its page. */
@Component({
  selector: 'app-party-host-dialog',
  imports: [FormsModule, TranslatePipe, ModalHeaderComponent, PartyHostSwitchesComponent, PartyInviteePickerComponent, TvRowDirective],
  templateUrl: './party-host-dialog.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PartyHostDialogComponent {
  private readonly api = inject(PartyApiService);
  private readonly confirm = inject(ConfirmationService);
  private readonly translate = inject(TranslateService);
  private readonly party = inject(PartyService);
  protected readonly keyboard = inject(KeyboardOverlayService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  readonly view = input.required<PartyDto>();
  /** In the lobby: the party service owns the snapshot and applies the changes itself. */
  readonly joined = input.required<boolean>();
  readonly link = input.required<string>();
  /** The snapshot the server returned after a change. */
  readonly updated = output<PartyDto>();

  protected readonly excluded = computed(() => [this.view().host.userId, ...this.view().guests.map((i) => i.userId)]);
  protected readonly busy = signal(false);
  protected readonly rescheduling = signal(false);
  protected readonly newWhen = signal('');
  protected readonly inviting = signal(false);
  protected readonly newInvitees = signal<number[]>([]);

  show(): void {
    this.rescheduling.set(false);
    this.inviting.set(false);
    this.newInvitees.set([]);
    this.dialog().nativeElement.showModal();
  }

  protected async setSwitches(patch: Partial<PartySwitches>): Promise<void> {
    if (this.joined()) return this.party.updateSettings(patch);
    const dto = await runBusy(this.busy, () => this.api.update(this.view().id, patch));
    if (dto) this.updated.emit(dto);
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

  protected openReschedule(): void {
    const at = this.view().scheduledAt;
    this.newWhen.set(toLocalInput(at ? new Date(at) : new Date()));
    this.rescheduling.set(true);
  }

  protected async reschedule(): Promise<void> {
    if (!this.newWhen()) return;
    const at = new Date(this.newWhen());
    const ok = await this.confirm.confirm({
      title: this.translate.instant('party.reschedule_title'),
      message: this.translate.instant('party.reschedule_message', {
        name: this.view().name,
        when: partyWhen(at.toISOString(), this.translate, Date.now()),
      }),
      confirmLabel: this.translate.instant('party.reschedule'),
    });
    if (!ok) return;
    const dto = await runBusy(this.busy, () => this.api.update(this.view().id, { scheduledAt: at.toISOString() }));
    if (!dto) return;
    this.updated.emit(dto);
    this.rescheduling.set(false);
  }

  protected async invite(): Promise<void> {
    const ids = this.newInvitees();
    if (!ids.length) return;
    const dto = await runBusy(this.busy, () => this.api.invite(this.view().id, ids));
    if (!dto) return;
    this.updated.emit(dto);
    this.newInvitees.set([]);
    this.inviting.set(false);
  }
}
