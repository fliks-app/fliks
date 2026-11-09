import { Component, computed, inject, signal } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LucidePlay, LucidePlus, LucideX } from '@lucide/angular';
import type { PartyProposal } from '../../../core/services/api/party-api.service';
import { MusicApiService } from '../../../core/services/api/music-api.service';
import type { TrackRow } from '../../../core/services/api/music.models';
import { AuthService } from '../../../core/services/auth.service';
import { DeviceService } from '../../../core/services/device.service';
import { PartyService } from '../../../core/services/party/party.service';
import { runBusy } from '../../../features/party/party-busy';
import { TvSectionDirective } from '../../directives/tv-section.directive';

const SEARCH_DELAY_MS = 300;
const MIN_QUERY = 2;
const RESULTS = 6;

/** The party's singer queue: songs waiting in singing order, the next singer, adding a song and, for the host, playing one. */
@Component({
  selector: 'app-karaoke-queue',
  imports: [TranslatePipe, TvSectionDirective, LucidePlay, LucidePlus, LucideX],
  templateUrl: './karaoke-queue.html',
})
export class KaraokeQueueComponent {
  protected readonly party = inject(PartyService);
  private readonly music = inject(MusicApiService);
  private readonly me = inject(AuthService).user;
  protected readonly tv = inject(DeviceService).isTv;

  protected readonly queue = this.party.singerQueue;
  protected readonly next = computed(() => this.queue()[0] ?? null);
  protected readonly query = signal('');
  protected readonly results = signal<TrackRow[]>([]);
  protected readonly busy = signal(false);

  private timer: ReturnType<typeof setTimeout> | null = null;
  private searched = 0;

  protected name(userId: number): string {
    const p = this.party.party();
    const found = this.party.members().find((m) => m.userId === userId) ?? p?.guests.find((g) => g.userId === userId) ?? (p?.host.userId === userId ? p.host : null);
    return found?.username ?? '';
  }

  protected mine(p: PartyProposal): boolean {
    return p.proposedBy === this.me()?.id;
  }

  protected onInput(value: string): void {
    this.query.set(value);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.search(), SEARCH_DELAY_MS);
  }

  private async search(): Promise<void> {
    const q = this.query().trim();
    const at = ++this.searched;
    if (q.length < MIN_QUERY) return void this.results.set([]);
    try {
      const rows = await this.music.tracks({ q, limit: RESULTS });
      if (at === this.searched) this.results.set(rows.filter((r) => r.hasFile));
    } catch {
      if (at === this.searched) this.results.set([]);
    }
  }

  protected async add(t: TrackRow): Promise<void> {
    const done = await runBusy(this.busy, () => this.party.proposeTrack(t.mediaId, t.itemId));
    if (done) {
      this.query.set('');
      this.results.set([]);
    }
  }

  protected async cancel(p: PartyProposal): Promise<void> {
    const id = this.party.party()?.id;
    if (id != null) await runBusy(this.busy, () => this.party.cancelProposal(id, p.id));
  }

  protected play(p?: PartyProposal): Promise<unknown> {
    return runBusy(this.busy, () => this.party.playSinger(p?.id));
  }
}
