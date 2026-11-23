import { Injectable } from '@angular/core';
import { classifyPlaybackError, isUndecodableError, type PlaybackError } from '../../core/services/playback-engine/playback-error';
import type { ReloadWhy } from './player-qoe';
import type { PlaybackMode } from '../../core/utils/player.utils';

/** What the controller needs from the player, so it never reaches into the
 *  component directly. */
export interface CopyFallbackHost {
  isDestroyed(): boolean;
  playbackMode(): PlaybackMode;
  currentSid(): string | undefined;
  currentMediaFileId(): number;
  hasServerFeature(feature: string): boolean;
  /** Reloads the stream; one asked while a load runs waits for it. */
  reloadStream(position: number, why: ReloadWhy): Promise<'done' | 'superseded' | 'failed'>;
  /** Ends playback on the error card. */
  fail(e: unknown): void;
}

const DEVICE_PROFILE_EXTENSIONS_FEATURE = 'deviceProfileExtensions';

/** Copy fallback: an undecodable copy is rejected once per session and reloaded, with the failed audio codec
 *  dropped from the profile when the engine names it, else one step down: DirectPlay to a remux, a remux to
 *  `rejectCopy`. One per player, bound via {@link attach}. */
@Injectable()
export class CopyFallbackController {
  private host!: CopyFallbackHost;

  /** Files whose copy this device failed to decode: every later playback-info
   *  for them asks `rejectCopy`, so no reload bounces back onto that copy. */
  private readonly rejectCopyFileIds = new Set<number>();
  /** Files whose raw file this device failed to play: renegotiated without DirectPlay, so the copy survives. */
  private readonly remuxFileIds = new Set<number>();
  /** Audio codecs this device failed to decode, per file: dropped from every later profile for it. */
  private readonly rejectedAudio = new Map<number, Set<string>>();
  /** Session the fallback already retried once for. Keyed by sid (not a plain
   *  boolean) so the next negotiation re-arms it. */
  private remuxFallbackSid: string | undefined;
  /** The rejectCopy reload in flight, so a second report of the same failure
   *  (an `error` event plus the rejected load()) is absorbed, not carded. */
  private remuxFallback: Promise<void> | null = null;
  /** Caller setup to run once the fallback reload succeeds; either report may supply it. */
  private remuxFallbackOnRecovered: (() => Promise<void> | void) | undefined;

  attach(host: CopyFallbackHost): void {
    this.host = host;
  }

  /** `rejectCopy` forced on when `mediaFileId` is a confirmed offender and the
   *  server accepts the field (an unknown field 400s older servers). */
  shouldForceRejectCopy(mediaFileId: number): boolean {
    return (
      this.rejectCopyFileIds.has(mediaFileId) &&
      this.host.hasServerFeature(DEVICE_PROFILE_EXTENSIONS_FEATURE)
    );
  }

  shouldForceRemux(mediaFileId: number): boolean {
    return this.remuxFileIds.has(mediaFileId);
  }

  rejectedAudioCodecs(mediaFileId: number): ReadonlySet<string> {
    return this.rejectedAudio.get(mediaFileId) ?? new Set();
  }

  /** For a caught load()/reload rejection: Shaka throws load-time fatals (4032/4012) without an `error` event;
   *  `onRecovered` runs the post-load setup the caller's catch skipped. */
  fallBackFromLoadError(
    e: any, position: number, onRecovered?: () => Promise<void> | void,
  ): boolean {
    const { source, code } = classifyPlaybackError(e);
    return this.maybeFallback(
      { source, code, message: e?.message ?? String(e) }, position, onRecovered,
    );
  }

  /** An undecodable copy: reject it and reload once per session through `reloadStream`. A copied audio codec the
   *  engine names is dropped in any mode, else DirectPlay steps to a remux, a remux to `rejectCopy`; none can loop.
   *  True when handled. */
  maybeFallback(
    err: { source?: PlaybackError['source']; code?: number; message?: string; audioCodec?: string },
    position: number,
    onRecovered?: () => Promise<void> | void,
  ): boolean {
    if (this.host.isDestroyed()) return false;
    if (!isUndecodableError(err)) return false;
    const sid = this.host.currentSid();
    if (!sid) return false;
    if (this.remuxFallbackSid === sid) {
      if (this.remuxFallback && onRecovered) this.remuxFallbackOnRecovered ??= onRecovered;
      return this.remuxFallback != null;
    }
    const fileId = this.host.currentMediaFileId();
    const audio = err.audioCodec?.toLowerCase();
    let why: ReloadWhy;
    if (audio) {
      const rejected = this.rejectedAudio.get(fileId) ?? new Set<string>();
      if (rejected.has(audio)) return false;
      this.rejectedAudio.set(fileId, rejected.add(audio));
      why = { reason: 'audio_fallback', from: audio };
      console.warn(`[player] ${audio} audio failed to decode, retrying without it`);
    } else if (this.host.playbackMode() === 'direct') {
      // A raw file that fails says nothing of its codecs: the remux keeps them, and its own failure transcodes.
      this.remuxFileIds.add(fileId);
      why = { reason: 'direct_fallback' };
      console.warn('[player] direct play failed, retrying as a remux');
    } else {
      if (this.host.playbackMode() !== 'remux') return false;
      if (!this.host.hasServerFeature(DEVICE_PROFILE_EXTENSIONS_FEATURE)) return false;
      this.rejectCopyFileIds.add(fileId);
      why = { reason: 'remux_fallback' };
      console.warn('[player] copy failed to decode, retrying with rejectCopy');
    }
    this.remuxFallbackSid = sid;
    this.remuxFallbackOnRecovered = onRecovered;
    this.remuxFallback = this.runRemuxFallback(position, why).finally(() => {
      this.remuxFallback = null;
      this.remuxFallbackOnRecovered = undefined;
    });
    return true;
  }

  /** The load path that reported the failure is still running: the reload waits for it in the loader's slot.
   *  Always cards on failure: the copy is gone. */
  private async runRemuxFallback(position: number, why: ReloadWhy): Promise<void> {
    try {
      const outcome = await this.host.reloadStream(position, why);
      if (outcome === 'failed') throw new Error('remux fallback reload failed');
      if (outcome === 'done') await this.remuxFallbackOnRecovered?.();
    } catch (e) {
      this.host.fail(e);
    }
  }
}
