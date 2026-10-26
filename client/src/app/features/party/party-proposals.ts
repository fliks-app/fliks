import { ChangeDetectionStrategy, Component, ElementRef, Injector, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideThumbsUp, LucideTrash2 } from '@lucide/angular';
import { PartyApiService, type PartyDto, type PartyProposal } from '../../core/services/api/party-api.service';
import { AuthService } from '../../core/services/auth.service';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { MediaPickerComponent, type MediaPick } from '../../shared/components/media-picker/media-picker';
import { UserAvatarComponent } from '../../shared/components/user-avatar/user-avatar';
import { TvRowDirective } from '../../shared/directives/tv-row.directive';
import { type PartyPerson } from '../player/party/party-people';
import { keepFocus, runBusy } from './party-busy';

/** Most votes first, the oldest (lowest id) among equals; the server resolves a start the same way. */
export function sortProposals(list: readonly PartyProposal[]): PartyProposal[] {
  return [...list].sort((a, b) => b.voterIds.length - a.voterIds.length || a.id - b.id);
}

/** The party's film proposals: propose, vote, remove, and for the host pick one. */
@Component({
  selector: 'app-party-proposals',
  imports: [TranslatePipe, ResolveUrlPipe, TvRowDirective, UserAvatarComponent, MediaPickerComponent, LucideThumbsUp, LucideTrash2],
  templateUrl: './party-proposals.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PartyProposalsComponent {
  private readonly api = inject(PartyApiService);
  private readonly auth = inject(AuthService);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly partyId = input.required<number>();
  readonly proposals = input.required<PartyProposal[]>();
  readonly people = input.required<PartyPerson[]>();
  readonly isHost = input(false);
  /** The host's pick, as the party's new snapshot. */
  readonly chosen = output<PartyDto>();

  protected readonly picker = viewChild.required(MediaPickerComponent);
  protected readonly busy = signal(false);
  protected readonly me = computed(() => this.auth.user()?.id ?? null);
  protected readonly rows = computed(() => sortProposals(this.proposals()));

  /** The proposal whose vote button holds the focus: a re-sort moves its row and drops it. */
  private focused: number | null = null;

  constructor() {
    effect(() => {
      this.rows();
      untracked(() => this.restoreFocus());
    });
  }

  private restoreFocus(): void {
    const id = this.focused;
    if (id == null) return;
    keepFocus(this.injector, () => this.host.nativeElement.querySelector<HTMLElement>(`[data-vote="${id}"]`));
  }

  protected name(userId: number): string {
    return this.people().find((p) => p.userId === userId)?.username ?? '?';
  }

  protected voted(p: PartyProposal): boolean {
    return p.voterIds.includes(this.me() ?? -1);
  }

  protected canRemove(p: PartyProposal): boolean {
    return this.isHost() || p.proposedBy === this.me();
  }

  protected propose(picks: MediaPick[]): void {
    const [pick] = picks;
    if (pick) void runBusy(this.busy, () => this.api.propose(this.partyId(), pick.mediaId, pick.episodeId ?? undefined));
  }

  protected async vote(p: PartyProposal): Promise<void> {
    this.focused = p.id;
    await runBusy(this.busy, () => this.api.vote(this.partyId(), p.id, !this.voted(p)));
    this.restoreFocus();
  }

  protected remove(p: PartyProposal): void {
    void runBusy(this.busy, () => this.api.unpropose(this.partyId(), p.id));
  }

  protected async choose(p: PartyProposal): Promise<void> {
    const dto = await runBusy(this.busy, () => this.api.choose(this.partyId(), p.id));
    if (dto) this.chosen.emit(dto);
  }
}
