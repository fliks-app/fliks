import type { DesktopMediaMetadata, DesktopPlayerState, DesktopPositionInfo } from '../shared/contract';

export interface NowPlayingNative {
  setNowPlaying(info: {
    title: string;
    artist?: string;
    artwork?: Buffer;
    duration: number;
    elapsed: number;
    playing: boolean;
  }): void;
  clearNowPlaying(): void;
}

/** The OS extrapolates the elapsed time from the rate: only a seek or drift past this needs a push. */
const DRIFT_SECONDS = 3;

/** macOS Now Playing: pushed on state changes and when the position leaves the OS's own extrapolation. */
export class NowPlaying {
  private meta: DesktopMediaMetadata | null = null;
  private artwork: Buffer | undefined;
  private artworkSent = false;
  private active = false;
  private playing = false;
  private duration = 0;
  private position = 0;
  private pushedAt = 0;
  private pushedPosition = 0;

  constructor(
    private readonly native: NowPlayingNative,
    private readonly now: () => number = Date.now,
  ) {}

  /** Null withdraws the session. `artwork` is the image bytes, fetched by the caller. */
  setMetadata(meta: DesktopMediaMetadata | null, artwork?: Buffer): void {
    this.meta = meta;
    this.artwork = artwork;
    this.artworkSent = false;
    if (!meta) this.clear();
    else if (this.active) this.push();
  }

  setState(state: DesktopPlayerState): void {
    if (state === 'playing' || state === 'paused') {
      this.playing = state === 'playing';
      this.active = true;
      this.push();
    } else if (state === 'ended' || state === 'idle' || state === 'error') {
      this.clear();
    }
  }

  setPosition({ position, duration }: DesktopPositionInfo): void {
    this.position = position;
    this.duration = duration;
    if (!this.active) return;
    const expected = this.pushedPosition + (this.playing ? (this.now() - this.pushedAt) / 1000 : 0);
    if (Math.abs(position - expected) > DRIFT_SECONDS) this.push();
  }

  private push(): void {
    if (!this.meta) return;
    this.native.setNowPlaying({
      title: this.meta.title,
      artist: this.meta.artist,
      artwork: this.artworkSent ? undefined : this.artwork,
      duration: this.duration,
      elapsed: this.position,
      playing: this.playing,
    });
    this.artworkSent = true;
    this.pushedAt = this.now();
    this.pushedPosition = this.position;
  }

  private clear(): void {
    this.active = false;
    this.artworkSent = false;
    this.native.clearNowPlaying();
  }
}
