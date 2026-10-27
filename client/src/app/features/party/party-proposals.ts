import { ChangeDetectionStrategy, Component, ElementRef, Injector, afterNextRender, computed, effect, inject, input, linkedSignal, output, signal, untracked, viewChild } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucideLightbulb, LucideThumbsDown, LucideThumbsUp, LucideTrash2 } from '@lucide/angular';
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
import { reducedMotion, rowTops, slideRows } from './party-flip';
import { itemThumb } from './party-thumb';
import { episodeLabel } from '../../shared/utils/episode-label';

/** Most votes for first, then fewest against; a tie keeps its place in `shown`, else the oldest (lowest id) first. */
export function sortProposals(list: readonly PartyProposal[], shown: readonly PartyProposal[] = []): PartyProposal[] {
  const at = (p: PartyProposal) => {
    const i = shown.findIndex((s) => s.id === p.id);
    return i < 0 ? Infinity : i;
  };
  return [...list].sort(
    (a, b) => b.upvoterIds.length - a.upvoterIds.length || a.downvoterIds.length - b.downvoterIds.length || at(a) - at(b) || a.id - b.id,
  );
}

/** The proposals sharing the best votes (for, then against); one entry when there is a clear winner. */
export function bestProposals(list: readonly PartyProposal[]): PartyProposal[] {
  const [a, ...rest] = sortProposals(list);
  if (!a) return [];
  const same = (p: PartyProposal) => p.upvoterIds.length === a.upvoterIds.length && p.downvoterIds.length === a.downvoterIds.length;
  return [a, ...rest.filter(same)];
}

/** The proposal a start on the top vote plays; null without one or on a tie for first. */
export function topProposal(list: readonly PartyProposal[]): PartyProposal | null {
  const best = bestProposals(list);
  return best.length === 1 ? best[0] : null;
}

const LONG_PRESS_MS = 500;

/** A vote cast pops with a tilt toward its direction; a vote taken back shrinks for a beat. */
const bump = (value: 1 | -1, cast: boolean): Keyframe[] => [
  { transform: 'scale(1) rotate(0)' },
  { transform: cast ? `scale(1.4) rotate(${value * -14}deg)` : 'scale(0.7)', offset: 0.35 },
  { transform: cast ? 'scale(0.92) rotate(0)' : 'scale(1.08)', offset: 0.7 },
  { transform: 'scale(1) rotate(0)' },
];

/** The party's film proposals: propose, vote, remove, and for the host pick one. */
@Component({
  selector: 'app-party-proposals',
  imports: [TranslatePipe, ResolveUrlPipe, TvRowDirective, MediaPickerComponent, ModalHeaderComponent, UserAvatarComponent, LucideLightbulb, LucideThumbsDown, LucideThumbsUp, LucideTrash2],
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
  protected readonly rows = linkedSignal<PartyProposal[], PartyProposal[]>({
    source: this.proposals,
    computation: (list, prev) => sortProposals(list, prev?.value),
  });
  protected readonly taken = computed(() => this.proposals().map((p) => p.item));

  /** The proposal whose vote button holds the focus: a re-sort moves its row and drops it. */
  private focused: { id: number; value: 1 | -1 } | null = null;
  /** Voters last seen per proposal, to spot the votes other people cast. */
  private seen: Map<number, { up: number[]; down: number[] }> | null = null;

  constructor() {
    effect(() => {
      this.rows();
      untracked(() => {
        const root = this.host.nativeElement;
        const before = rowTops(root);
        afterNextRender(() => slideRows(root, before), { injector: this.injector });
        this.restoreFocus();
      });
    });
    effect(() => {
      const list = this.proposals();
      untracked(() => this.bumpOthersVotes(list));
    });
  }

  private bumpOthersVotes(list: readonly PartyProposal[]): void {
    const before = this.seen;
    this.seen = new Map(list.map((p) => [p.id, { up: p.upvoterIds, down: p.downvoterIds }]));
    if (!before || reducedMotion()) return;
    const me = this.me();
    const gained = (a: number[], b: number[]) => a.some((u) => u !== me && !b.includes(u));
    const hits = list.flatMap((p) => {
      const was = before.get(p.id);
      if (!was) return [];
      return ([[1, p.upvoterIds, was.up], [-1, p.downvoterIds, was.down]] as const).flatMap(([value, now, then]) =>
        gained(now, then) ? [{ id: p.id, value, cast: true }] : gained(then, now) ? [{ id: p.id, value, cast: false }] : [],
      );
    });
    if (!hits.length) return;
    afterNextRender(
      () => {
        for (const { id, value, cast } of hits) {
          this.host.nativeElement
            .querySelector<HTMLElement>(`[data-vote="${id}"][data-value="${value}"] svg`)
            ?.animate(bump(value, cast), { duration: 450, easing: 'ease-out' });
        }
      },
      { injector: this.injector },
    );
  }

  private restoreFocus(): void {
    const f = this.focused;
    if (!f) return;
    keepFocus(this.injector, () => this.host.nativeElement.querySelector<HTMLElement>(`[data-vote="${f.id}"][data-value="${f.value}"]`));
  }

  protected readonly thumb = itemThumb;

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
    if (picks.length) void runBusy(this.busy, () => this.api.proposeMany(this.partyId(), picks));
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
