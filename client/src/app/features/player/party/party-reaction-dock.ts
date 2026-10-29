import { ChangeDetectionStrategy, Component, DestroyRef, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideMic, LucideMicOff } from '@lucide/angular';
import { ReactionsService } from '../../../core/services/party/reactions.service';
import { PartyService } from '../../../core/services/party/party.service';
import { VoiceService } from '../../../core/services/party/voice.service';
import { ControlsVisibilityService } from '../controls/controls-visibility';
import { TvRowDirective } from '../../../shared/directives/tv-row.directive';

const POP_MS = 220;
// Held this long, the mic button talks only while pressed.
const HOLD_MS = 250;

/** The player's action strip: a row of emojis, one tap sends; in voice, a mic button follows (a tap toggles it, a hold talks while pressed). */
@Component({
  selector: 'app-party-reaction-dock',
  imports: [TranslatePipe, LucideMic, LucideMicOff, TvRowDirective],
  templateUrl: './party-reaction-dock.html',
  styleUrl: './party-reaction-dock.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // The player wakes its controls on any click or pointer move; the dock is used without them.
  host: { '(click)': '$event.stopPropagation()', '(mousemove)': '$event.stopPropagation()' },
})
export class PartyReactionDockComponent {
  private readonly party = inject(PartyService);
  protected readonly reactions = inject(ReactionsService);
  protected readonly voice = inject(VoiceService);
  private readonly chrome = inject(ControlsVisibilityService);
  private holdTimer?: ReturnType<typeof setTimeout>;
  private held = false;
  private heldFromMuted = false;
  private readonly release = () => this.micUp(false);

  constructor() {
    inject(DestroyRef).onDestroy(() => this.micUp(false));
  }

  protected send(emoji: string, event: Event): void {
    this.party.react(emoji);
    (event.currentTarget as HTMLElement).animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.2)' }, { transform: 'scale(1)' }],
      { duration: POP_MS, easing: 'ease-out' },
    );
  }

  protected micDown(): void {
    clearTimeout(this.holdTimer);
    // The strip can unmount mid-press (controls hide), so the release is heard on the document.
    this.chrome.holding.set(true);
    document.addEventListener('pointerup', this.release);
    document.addEventListener('pointercancel', this.release);
    this.holdTimer = setTimeout(() => {
      this.held = true;
      this.heldFromMuted = this.voice.muted();
      if (this.heldFromMuted) void this.voice.setMuted(false);
    }, HOLD_MS);
  }

  /** A pointer tap acts on release: Android sends no click after a long press. */
  protected micUp(released: boolean): void {
    clearTimeout(this.holdTimer);
    this.chrome.holding.set(false);
    document.removeEventListener('pointerup', this.release);
    document.removeEventListener('pointercancel', this.release);
    if (this.held) {
      this.held = false;
      if (this.heldFromMuted) void this.voice.setMuted(true);
    } else if (released) void this.voice.toggleMute();
  }

  /** Only a keyboard or D-pad activation (`detail` 0): pointer taps went through `micUp`. */
  protected micClick(event: MouseEvent): void {
    if (event.detail === 0) void this.voice.toggleMute();
  }
}
