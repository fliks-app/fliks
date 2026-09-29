import { Injectable } from '@angular/core';
import { classifyPlaybackError, isUndecodableError, type PlaybackError } from '../../core/services/playback-engine/playback-error';
import type { PlaybackMode } from '../../core/utils/player.utils';

/** What the controller needs from the player, so it never reaches into the
 *  component directly. */
export interface CopyFallbackHost {
  isDestroyed(): boolean;
  playbackMode(): PlaybackMode;
  currentSid(): string | undefined;
  currentMediaFileId(): number;
  hasServerFeature(feature: string): boolean;
  /** Sync snapshot of "no reload/recovery holds the engine right now". */
  isReloadIdle(): boolean;
  reloadStream(position: number): Promise<void>;
  hasError(): boolean;
  failWith(e: unknown, opts?: { source?: PlaybackError['source'] }): void;
  setRecovering(recovering: boolean): void;
}

const DEVICE_PROFILE_EXTENSIONS_FEATURE = 'deviceProfileExtensions';
const RELOAD_IDLE_WAIT_MS = 3_000;

/**
 * Owns the DirectPlay/remux -> transcode fallback: when a copy delivery turns
 * out undecodable, reject it once per session and reload through `rejectCopy`
 * so the backend forces a transcode. Provided per player component and wired
 * to it via {@link attach}, since Angular can't inject constructor args into
 * a component-scoped service.
 */
@Injectable()
export class CopyFallbackController {
  private host!: CopyFallbackHost;

  /** Files whose copy this device failed to decode: every later playback-info
   *  for them asks `rejectCopy`, so no reload bounces back onto that copy. */
  private readonly rejectCopyFileIds = new Set<number>();
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

  /** For a caught load()/reload rejection: Shaka throws load-time fatals
   *  (4032/4012) without emitting an `error` event. `onRecovered` runs the
   *  post-load setup the caller's own catch skipped. */
  fallBackFromLoadError(
    e: any, position: number, onRecovered?: () => Promise<void> | void,
  ): boolean {
    const { source, code } = classifyPlaybackError(e);
    return this.maybeFallback(
      { source, code, message: e?.message ?? String(e) }, position, onRecovered,
    );
  }

  /** An undecodable copy (DirectPlay or remux): reject it and reload once per session
   *  through `reloadStream`; `rejectCopy` forces a transcode, so it can't loop. True when handled. */
  maybeFallback(
    err: { source?: PlaybackError['source']; code?: number; message?: string },
    position: number,
    onRecovered?: () => Promise<void> | void,
  ): boolean {
    if (this.host.isDestroyed()) return false;
    const mode = this.host.playbackMode();
    if (mode !== 'remux' && mode !== 'direct') return false;
    if (!this.host.hasServerFeature(DEVICE_PROFILE_EXTENSIONS_FEATURE)) return false;
    if (!isUndecodableError(err)) return false;
    const sid = this.host.currentSid();
    if (!sid) return false;
    if (this.remuxFallbackSid === sid) {
      if (this.remuxFallback && onRecovered) this.remuxFallbackOnRecovered ??= onRecovered;
      return this.remuxFallback != null;
    }
    this.remuxFallbackSid = sid;
    this.rejectCopyFileIds.add(this.host.currentMediaFileId());
    console.warn('[player] copy failed to decode, retrying with rejectCopy');
    this.remuxFallbackOnRecovered = onRecovered;
    this.remuxFallback = this.runRemuxFallback(position).finally(() => {
      this.remuxFallback = null;
      this.remuxFallbackOnRecovered = undefined;
    });
    return true;
  }

  /** The load path that reported the failure still holds its reload guard, so
   *  wait for it before reloading. Always cards on failure: the copy is gone. */
  private async runRemuxFallback(position: number): Promise<void> {
    this.host.setRecovering(true);
    try {
      if (!(await this.waitForReloadIdle())) {
        console.warn('[player] remux fallback dropped: another reload is still running');
        if (!this.host.hasError()) {
          this.host.failWith(
            new Error('remux fallback dropped: another reload is still running'),
            { source: 'session' },
          );
        }
        return;
      }
      // A recovery that settled meanwhile lowered the veil.
      this.host.setRecovering(true);
      await this.host.reloadStream(position);
      await this.remuxFallbackOnRecovered?.();
    } catch (e) {
      if (!this.host.hasError()) this.host.failWith(e);
    } finally {
      this.host.setRecovering(false);
    }
  }

  /** Resolves true once no reload or session recovery holds the engine, false
   *  if one is still running after {@link RELOAD_IDLE_WAIT_MS}. Also used
   *  outside the fallback path (pre-roll advance) to wait out the same guard. */
  async waitForReloadIdle(): Promise<boolean> {
    const deadline = Date.now() + RELOAD_IDLE_WAIT_MS;
    while (!this.host.isReloadIdle() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return this.host.isReloadIdle();
  }
}
