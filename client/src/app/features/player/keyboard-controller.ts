import type { PlaybackEngine } from '../../core/services/playback-engine/playback-engine';
import type { PlayerControlsComponent } from './controls/player-controls';
import type { ControlsVisibilityService } from './controls/controls-visibility';
import { mediaKeyAction } from './media-keys';

export interface KeyboardHost {
  chrome: ControlsVisibilityService;
  engine(): PlaybackEngine | null;
  controls(): PlayerControlsComponent | undefined;
  isTv(): boolean;
  /** False for a non-host of a host-only party: play, pause and seek keys do nothing. */
  canControlPlayback(): boolean;
  playbackRate(): number;
  onTogglePlay(): void;
  onSeek(time: number): void;
  onToggleFullscreen(): void;
  onToggleMute(): void;
  onTogglePip(): void;
  toggleStats(): void;
  onBack(): void;
  onSpeedChange(rate: number): void;
  stepFrame(direction: -1 | 1): void;
  /** A party with reactions on: ArrowDown on a hidden bar raises the reaction row alone. */
  reactionsAvailable(): boolean;
  openReactions(): void;
}

/** The player's document-level keyboard and TV-remote shortcuts. */
export class KeyboardController {
  constructor(private readonly host: KeyboardHost) {}

  onKeyDown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    const engine = this.host.engine();
    if (!engine) return;
    const control = this.host.canControlPlayback();

    // Back keys must bubble to the window handler in `app.ts` so the player can be left.
    // Older Tizen reports 10009 with no reliable `e.key`, so `keyCode` stays load-bearing.
    const tizenKeyCode = (e as { keyCode: number }).keyCode;
    const isBackKey =
      tizenKeyCode === 10009 || e.key === 'XF86Back' || e.key === 'GoBack' || e.key === 'Escape';

    // A focused floating cue is visible while the bar is hidden: it gets its activation key.
    const activeEl = document.activeElement as HTMLElement | null;
    const cueFocused = !!activeEl?.closest('.player-floating-cue');
    // The reaction row stays up without the bar: its arrows and OK pick and send.
    const isRowKey = e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Enter';
    const floatingKey = cueFocused || (isRowKey && !!activeEl?.closest('app-party-reaction-dock'));
    // An open dialog (settings, reactions) owns every key, arrows included, even with focus left behind it.
    if (document.querySelector('dialog[open]')) return;
    // The sync panel owns its keys; only Back still reaches the handlers below.
    if (!isBackKey && activeEl?.closest('app-subtitle-sync-panel')) return;

    // Hidden bar: Up raises the controls, Down the reaction row alone; Back closes the row.
    const chrome = this.host.chrome;
    if (!chrome.visible()) {
      const reactions = chrome.reactionsOnly();
      if (e.key === 'ArrowUp' || (e.key === 'ArrowDown' && !reactions)) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'ArrowDown' && this.host.reactionsAvailable()) this.host.openReactions();
        else chrome.show();
        return;
      }
      if (reactions && (isBackKey || e.key === 'ArrowDown')) {
        e.preventDefault();
        e.stopPropagation();
        if (isBackKey) chrome.hide();
        return;
      }
      if (reactions && floatingKey) chrome.resetHideTimer();
    }

    const media = mediaKeyAction({ key: e.key, keyCode: tizenKeyCode });
    if (media) {
      e.preventDefault();
      e.stopPropagation();
      if (media === 'stop') {
        this.host.onBack();
        return;
      }
      if (!control) return;
      if (
        media === 'toggle' ||
        (media === 'play' && engine.paused) ||
        (media === 'pause' && !engine.paused)
      ) {
        this.host.onTogglePlay();
      } else if (media === 'forward') this.host.onSeek(engine.currentTime + 10);
      else if (media === 'rewind') this.host.onSeek(engine.currentTime - 10);
      this.host.chrome.show();
      return;
    }

    // Controls hidden + Left/Right: raise the seek OSD and let the seekbar own the scrub.
    const isSeekArrow = e.key === 'ArrowLeft' || e.key === 'ArrowRight';
    if (!this.host.chrome.visible() && isSeekArrow && control && !floatingKey) {
      e.preventDefault();
      e.stopPropagation();
      this.host.chrome.show(true);
      this.host.controls()?.scrubFromKey(e);
      return;
    }

    // OK on a hidden bar raises it instead of pressing its first (invisible) button, the back arrow.
    if (e.key === 'Enter' && !floatingKey && !this.host.chrome.visible()) {
      this.host.chrome.show();
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // Any other key on a hidden bar just wakes it, on TV or with focus left in the bar (Space still plays);
    // a focused cue and back are exempt.
    const inBar = !!activeEl?.closest('app-player-controls') && e.key !== ' ';
    if (!isBackKey && !floatingKey && !this.host.chrome.visible() && (this.host.isTv() || inBar)) {
      this.host.chrome.show();
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // The seekbar and D-pad navigation own ArrowLeft/Right unless nothing has focus.
    const arrowSeekAllowed = !activeEl || activeEl === document.body;

    switch (e.key) {
      case ' ':
      case 'k':
        // Space activates a focused control in the bar natively; 'k' always toggles playback.
        if (
          e.key === ' ' &&
          (cueFocused ||
            (this.host.chrome.visible() &&
              activeEl &&
              activeEl !== document.body &&
              activeEl.closest('app-player-controls')))
        ) {
          return; // fall through to native activation
        }
        e.preventDefault();
        if (control) this.host.onTogglePlay();
        break;
      // The trailing chrome.show() restarts the countdown, so the first-frame effect can't snap the bar shut.
      case 'ArrowLeft':
        if (!arrowSeekAllowed || !control) break;
        e.preventDefault();
        this.host.onSeek(engine.currentTime - 10);
        break;
      case 'ArrowRight':
        if (!arrowSeekAllowed || !control) break;
        e.preventDefault();
        this.host.onSeek(engine.currentTime + 10);
        break;
      case 'j':
        if (!control) break;
        e.preventDefault();
        this.host.onSeek(engine.currentTime - 30);
        break;
      case 'l':
        if (!control) break;
        e.preventDefault();
        this.host.onSeek(engine.currentTime + 30);
        break;
      case 'f':
        e.preventDefault();
        this.host.onToggleFullscreen();
        break;
      case 'm':
        e.preventDefault();
        this.host.onToggleMute();
        break;
      case 'p':
        e.preventDefault();
        this.host.onTogglePip();
        break;
      case 's':
        e.preventDefault();
        if (e.shiftKey) {
          this.host.toggleStats();
        }
        break;
      case 'Escape':
        e.preventDefault();
        if (this.host.chrome.visible()) {
          this.host.chrome.hide();
          return; // skip the trailing chrome.show()
        }
        this.host.onBack();
        break;
      case '<':
        e.preventDefault();
        this.host.onSpeedChange(Math.max(0.25, this.host.playbackRate() - 0.25));
        break;
      case '>':
        e.preventDefault();
        this.host.onSpeedChange(Math.min(2, this.host.playbackRate() + 0.25));
        break;
      case ',':
      case '.':
        if (!control) break;
        e.preventDefault();
        this.host.stepFrame(e.key === '.' ? 1 : -1);
        break;
    }
    // Not for back (`onPlayerBackEvent` would only hide the bar, so Return looks stuck) nor a focused cue or reaction row.
    if (!isBackKey && !floatingKey) this.host.chrome.show(isSeekArrow && this.host.chrome.seekOsd());
  };
}
