import { ChangeDetectionStrategy, Component, ElementRef, Injector, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucideThumbsDown, LucideThumbsUp, LucideTrash2 } from '@lucide/angular';
import { PartyApiService, type PartyDto, type PartyProposal } from '../../core/services/api/party-api.service';
import { AuthService } from '../../core/services/auth.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { MediaPickerComponent, type MediaPick } from '../../shared/components/media-picker/media-picker';
import { ModalHeaderComponent } from '../../shared/components/modal-header';
import { UserAvatarComponent } from '../../shared/components/user-avatar/user-avatar';
import { TvRowDirective } from '../../shared/directives/tv-row.directive';
import { type PartyPerson } from '../player/party/party-people';
import { keepFocus, runBusy } from './party-busy';
import { episodeLabel } from '../../shared/utils/episode-label';

const score = (p: PartyProposal): number => p.upvoterIds.length - p.downvoterIds.length;

/** Best score (ups minus downs) first, the oldest (lowest id) among equals; the server resolves a start the same way. */
export function sortProposals(list: readonly PartyProposal[]): PartyProposal[] {
  return [...list].sort((a, b) => score(b) - score(a) || a.id - b.id);
}

const LONG_PRESS_MS = 500;

/** The party's film proposals: propose, vote, remove, and for the host pick one. */
@Component({
  selector: 'app-party-proposals',
  imports: [TranslatePipe, ResolveUrlPipe, TvRowDirective, MediaPickerComponent, ModalHeaderComponent, UserAvatarComponent, LucideThumbsDown, LucideThumbsUp, LucideTrash2],
  templateUrl: './party-proposals.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PartyProposalsComponent {
  private readonly api = inject(PartyApiService);
  private readonly auth = inject(AuthService);
  private readonly injector = inject(Injector);
  private readonly confirm = inject(ConfirmationService);
  private readonly translate = inject(TranslateService);
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
  private focused: { id: number; value: 1 | -1 } | null = null;

  constructor() {
    effect(() => {
      this.rows();
      untracked(() => this.restoreFocus());
    });
  }

  private restoreFocus(): void {
    const f = this.focused;
    if (!f) return;
    keepFocus(this.injector, () => this.host.nativeElement.querySelector<HTMLElement>(`[data-vote="${f.id}"][data-value="${f.value}"]`));
  }

  protected name(userId: number): string {
    return this.people().find((p) => p.userId === userId)?.username ?? '?';
  }

  protected myVote(p: PartyProposal): 1 | -1 | null {
    const me = this.me() ?? -1;
    return p.upvoterIds.includes(me) ? 1 : p.downvoterIds.includes(me) ? -1 : null;
  }

  protected canRemove(p: PartyProposal): boolean {
    return this.isHost() || p.proposedBy === this.me();
  }

  protected propose(picks: MediaPick[]): void {
    const [pick] = picks;
    if (pick) void runBusy(this.busy, () => this.api.propose(this.partyId(), pick.mediaId, pick.episodeId ?? undefined));
  }

  protected async vote(p: PartyProposal, value: 1 | -1): Promise<void> {
    if (this.longPressed) {
      this.longPressed = false;
      return;
    }
    this.focused = { id: p.id, value };
    const next = this.myVote(p) === value ? null : value;
    await runBusy(this.busy, () => this.api.vote(this.partyId(), p.id, next));
    this.restoreFocus();
  }

  protected readonly voters = signal<PartyProposal | null>(null);
  private readonly votersDialog = viewChild.required<ElementRef<HTMLDialogElement>>('votersDialog');
  private pressTimer: ReturnType<typeof setTimeout> | null = null;
  /** A long press opened the list: the click that may follow must not also vote. */
  private longPressed = false;

  protected showVoters(p: PartyProposal): void {
    this.voters.set(p);
    this.votersDialog().nativeElement.showModal();
  }

  /** A long press on a thumb lists the voters, the touch stand-in for clicking the count. */
  protected pressStart(p: PartyProposal): void {
    this.longPressed = false;
    this.pressEnd();
    this.pressTimer = setTimeout(() => {
      this.longPressed = true;
      this.showVoters(p);
    }, LONG_PRESS_MS);
  }

  protected pressEnd(): void {
    if (this.pressTimer) clearTimeout(this.pressTimer);
    this.pressTimer = null;
  }

  protected async remove(p: PartyProposal): Promise<void> {
    const ok = await this.confirm.confirm({
      title: this.translate.instant('party.proposal_remove'),
      message: this.translate.instant('party.proposal_remove_message', { title: p.item.hidden ? this.translate.instant('party.proposal_hidden') : episodeLabel(p.item) || p.item.title }),
      confirmLabel: this.translate.instant('party.proposal_remove'),
      variant: 'danger',
    });
    if (ok) void runBusy(this.busy, () => this.api.unpropose(this.partyId(), p.id));
  }

  protected async choose(p: PartyProposal): Promise<void> {
    const dto = await runBusy(this.busy, () => this.api.choose(this.partyId(), p.id));
    if (dto) this.chosen.emit(dto);
  }
}
