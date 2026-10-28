import { effect, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Immersive } from '../../core/plugins/immersive.plugin';
import { Orientation, releasePlayerOrientation } from '../../core/plugins/orientation.plugin';

export interface PlayerScreenHost {
  native: boolean;
  landscapeOnOpen: boolean;
  /** Portrait goes immersive while this holds (playing, bar hidden). */
  immersiveInPortrait(): boolean;
  /** Picture-in-picture owns the system bars. */
  suspended?(): boolean;
  /** A cast session keeps the phone free to turn. */
  casting?(): boolean;
  onRotate?(): void;
}

/** Orientation lock, landscape-on-open, immersive mode and the iOS reflow of a player. Create in an injection context. */
export class PlayerScreen {
  readonly canLock = Capacitor.getPlatform() === 'ios';
  readonly locked = signal(false);
  private readonly landscape = signal(screen.orientation?.type?.startsWith('landscape') ?? false);

  constructor(private readonly host: PlayerScreenHost) {
    effect(() => {
      if (!host.native || host.suspended?.()) return;
      if (this.landscape() || host.immersiveInPortrait()) {
        Immersive.enter({ displayBehindNotch: true }).catch(() => {});
        document.body.classList.add('immersive');
      } else {
        Immersive.exit().catch(() => {});
        document.body.classList.remove('immersive');
        Immersive.setLightStatusBar({ light: false }).catch(() => {});
      }
    });
  }

  open(): void {
    if (!this.host.native) return;
    screen.orientation?.addEventListener('change', this.onChange);
    if (!this.host.casting?.()) this.applyLandscapeOnOpen();
  }

  close(): void {
    if (!this.host.native) return;
    screen.orientation?.removeEventListener('change', this.onChange);
    Orientation.unlock().catch(() => {});
    Immersive.exit().catch(() => {});
    document.body.classList.remove('immersive');
  }

  toggleLock(): void {
    const locked = !this.locked();
    this.locked.set(locked);
    if (locked) Orientation.lock().catch(() => {});
    else releasePlayerOrientation(this.host.landscapeOnOpen);
  }

  /** The picture is on the TV: the phone turns freely. */
  releaseForCast(): void {
    if (!this.host.native) return;
    this.locked.set(false);
    Orientation.unlock().catch(() => {});
  }

  applyLandscapeOnOpen(): void {
    if (this.host.native && this.host.landscapeOnOpen) releasePlayerOrientation(true);
  }

  private readonly onChange = (): void => {
    this.landscape.set(screen.orientation?.type?.startsWith('landscape') ?? false);
    // iOS WKWebView sometimes leaves fixed elements unreflowed after a rotation.
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    document.documentElement.style.setProperty('--vh', `${window.innerHeight}px`);
    this.host.onRotate?.();
  };
}
