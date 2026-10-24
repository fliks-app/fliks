import type { CastService } from '../../core/services/cast.service';
import type { CastPlayerService } from '../../core/services/cast-player.service';
import { CAST_DRIFT_IGNORE_S, CAST_SEEK_COOLDOWN_MS } from './party-sync';

/** What the party controller drives: the local engine, or a Cast receiver. */
export interface PartyOutput {
  ready(): boolean;
  paused(): boolean;
  /** What the play control shows: differs from `paused` while a launch is in flight. */
  uiPaused(): boolean;
  buffering(): boolean;
  ended(): boolean;
  seekLocked(): boolean;
  position(): number;
  item(): { mediaId: number; episodeId: number | undefined };
  seekTo(time: number): void;
  pause(): Promise<void>;
  play(): void;
  /** A seek closer than this to the target is skipped. */
  readonly slackS: number;
  /** Drift thresholds; absent means the local defaults with rate nudging. */
  readonly drift?: { ignoreS: number; cooldownMs: number };
  rate?: { get(): number; set(rate: number): void };
}

/** The Cast receiver as a party output; the sender stays the member. */
export class CastPartyOutput implements PartyOutput {
  readonly slackS = CAST_DRIFT_IGNORE_S;
  readonly rate = undefined;
  readonly drift = { ignoreS: CAST_DRIFT_IGNORE_S, cooldownMs: CAST_SEEK_COOLDOWN_MS };

  constructor(
    private readonly cast: Pick<CastService, 'isConnected' | 'isPaused' | 'buffering' | 'currentTime' | 'duration' | 'seek' | 'play' | 'pause'>,
    private readonly player: Pick<CastPlayerService, 'hasMedia' | 'mediaId' | 'episodeId'>,
  ) {}

  ready = () => this.cast.isConnected() && this.player.hasMedia() && this.cast.duration() > 0;
  paused = () => this.cast.isPaused();
  uiPaused = () => this.cast.isPaused();
  buffering = () => this.cast.buffering();
  ended = () => false;
  seekLocked = () => false;
  position = () => this.cast.currentTime();
  item = () => ({ mediaId: this.player.mediaId(), episodeId: this.player.episodeId() });
  seekTo = (time: number) => this.cast.seek(time);
  pause = () => {
    this.cast.pause();
    return Promise.resolve();
  };
  play = () => this.cast.play();
}
