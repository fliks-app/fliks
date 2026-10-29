import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { LucidePlus, LucideX } from '@lucide/angular';
import type { PartySwitches } from '../../core/services/api/party-api.service';
import { PartyService, type PartyCreateTarget } from '../../core/services/party/party.service';
import { MediaPickerComponent, type MediaPick } from '../../shared/components/media-picker/media-picker';
import { ModalFooterComponent } from '../../shared/components/modal-footer';
import { ModalHeaderComponent } from '../../shared/components/modal-header';
import { PartyHostSwitchesComponent } from '../player/party/party-host-switches';
import { readStored, writeStored } from '../../core/services/party/local-flag';
import { AUTO_COVER, PartyCoverPickerComponent, coverChoice, coverValid, type CoverDraft } from './party-cover-picker';
import { PartyInviteePickerComponent } from './party-invitee-picker';

const SWITCHES_KEY = 'fliks.partySwitches';
const DEFAULT_SWITCHES: PartySwitches = { policy: 'everyone', reactionsEnabled: true, chatEnabled: true, linkSharing: true, public: false };

/** The switches of the last party created on this device, all on the first time. */
function storedSwitches(): PartySwitches {
  try {
    return { ...DEFAULT_SWITCHES, ...JSON.parse(readStored(SWITCHES_KEY) ?? '{}') };
  } catch {
    return DEFAULT_SWITCHES;
  }
}

/** `datetime-local` value (local time, minutes) for a date. */
export function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** "Watch together" dialog, mounted once in the layout and opened through `PartyService.createRequest`. */
@Component({
  selector: 'app-party-create-modal',
  imports: [FormsModule, TranslatePipe, LucidePlus, LucideX, ModalHeaderComponent, ModalFooterComponent, PartyInviteePickerComponent, PartyHostSwitchesComponent, MediaPickerComponent, PartyCoverPickerComponent],
  templateUrl: './party-create-modal.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PartyCreateModalComponent {
  private readonly party = inject(PartyService);
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly picker = viewChild.required(MediaPickerComponent);
  protected readonly target = signal<PartyCreateTarget | null>(null);
  /** The programme the party opens with; empty means the host chooses it later. */
  protected readonly films = signal<{ mediaId: number; mediaFileId?: number; episodeId: number | null; title: string; posterUrl: string | null }[]>([]);
  protected readonly groups = computed(() => {
    const out: { mediaId: number; title: string; count: number }[] = [];
    for (const f of this.films()) {
      const g = out.find((o) => o.mediaId === f.mediaId);
      if (g) g.count++;
      else out.push({ mediaId: f.mediaId, title: f.title, count: 1 });
    }
    return out;
  });
  protected readonly cover = signal<CoverDraft>(AUTO_COVER);
  protected readonly name = signal('');
  protected readonly later = signal(false);
  protected readonly when = signal('');
  protected readonly invitees = signal<number[]>([]);
  protected readonly switches = signal(DEFAULT_SWITCHES);
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
        this.films.set(req.mediaId == null ? [] : [{ mediaId: req.mediaId, mediaFileId: req.mediaFileId, episodeId: req.episodeId ?? null, title: req.title, posterUrl: null }]);
        this.name.set(req.title);
        this.cover.set(AUTO_COVER);
        this.later.set(false);
        const soon = new Date(Date.now() + 3_600_000);
        soon.setMinutes(0, 0, 0);
        this.when.set(toLocalInput(soon));
        this.min.set(toLocalInput(new Date()));
        this.invitees.set([]);
        this.switches.set(storedSwitches());
        this.open.set(true);
        dialog.nativeElement.showModal();
      });
    });
  }

  protected canSubmit(): boolean {
    return !this.busy() && this.name().trim().length > 0 && (!this.later() || !!this.when()) && coverValid(this.cover());
  }

  protected pick(picks: MediaPick[]): void {
    if (!picks.length) return;
    this.films.update((f) => [...f, ...picks.map(({ mediaId, episodeId, title, posterUrl }) => ({ mediaId, episodeId, title, posterUrl }))]);
    if (!this.name().trim()) this.name.set(picks[0].title);
  }

  protected setSwitches(patch: Partial<PartySwitches>): void {
    this.switches.update((s) => ({ ...s, ...patch }));
  }

  protected remove(mediaId: number): void {
    this.films.update((f) => f.filter((i) => i.mediaId !== mediaId));
    this.cover.update((c) => ({ ...c, picked: c.picked.filter((p) => p.mediaId !== mediaId) }));
  }

  protected close(): void {
    this.dialog()?.nativeElement.close();
  }

  protected async submit(): Promise<void> {
    const t = this.target();
    const films = this.films();
    if (!t || !this.canSubmit()) return;
    this.busy.set(true);
    try {
      const choice = coverChoice(this.cover());
      await this.party.create({
        name: this.name().trim(),
        ...(t.playlistId != null
          ? { playlistId: t.playlistId }
          : films.length > 0 && {
              items: films.map((f) => ({ mediaId: f.mediaId, ...(f.mediaFileId != null && { mediaFileId: f.mediaFileId }), ...(f.episodeId != null && { episodeId: f.episodeId }) })),
            }),
        ...(this.later() && { scheduledAt: new Date(this.when()).toISOString() }),
        ...(choice && { cover: choice }),
        inviteeIds: this.invitees(),
        ...this.switches(),
      }, (this.cover().mode === 'upload' ? this.cover().file : null) ?? undefined);
      writeStored(SWITCHES_KEY, JSON.stringify(this.switches()));
      this.close();
    } catch {
      /* the error interceptor already toasted it */
    } finally {
      this.busy.set(false);
    }
  }
}
