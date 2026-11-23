import { DestroyRef, effect, type Injector } from '@angular/core';
import type { CastPlayerService } from '../../core/services/cast-player.service';
import { RecoveryController } from './recovery-controller';

/** Recovery of the Cast receiver's stream; lazy, so the controller stays out of the initial chunk. */
export function castRecovery(s: CastPlayerService, injector: Injector): RecoveryController {
  const recovery = new RecoveryController({
    // The receiver keeps its own picture: there is no local stream to reset or unload.
    playhead: () => ({
      currentTime: s.cast.currentTime(),
      duration: s.cast.duration(),
      resetRecoveryGuard: () => {},
      unload: async () => {},
    }),
    isDestroyed: () => s.destroyed,
    isOnline: () => s.network.isOnline(),
    hasMedia: () => s.hasMedia(),
    isPaused: () => s.cast.isPaused(),
    isLoading: () => s.cast.buffering(),
    reloadInFlight: () => s.reloading(),
    resumePosition: () => (s.errorPosition > 0 ? s.errorPosition : s.cast.currentTime()),
    setRecovering: () => {},
    hasError: () => s.failed(),
    showFailure: () => {
      s.failed.set(true);
      s.toast.error(s.translate.instant('cast.error.recovery_failed'));
    },
    abandonReload: () => {
      s.reloads.cancel();
      s.reloading.set(false);
    },
    reloadSession: async (pos) => {
      const outcome = await s.reloadCastStream(pos);
      if (outcome === 'refused') throw new Error('cast LOAD refused');
      return outcome;
    },
    reportRecovery: (position, wait) => s.recordRecovery(position, wait?.reason),
  });
  // A recoverable receiver error (session GC'd, 410 on the next segment) reloads a fresh stream.
  s.cast.playbackError$.subscribe(({ position, mediaFileId }) => {
    if (mediaFileId != null && mediaFileId !== s.mediaFileId()) return;
    if (!s.hasMedia() || s.controlOnly() || !s.cast.receiverPlays(s.mediaFileId())) return;
    s.errorPosition = position ?? 0;
    void recovery.recoverFromLostSession('other');
    s.errorPosition = 0;
  });
  // A frozen receiver playhead is caught by the stall watchdog, polled once a second while media plays.
  effect(
    (onCleanup) => {
      if (!s.hasMedia() || !s.cast.isConnected()) return;
      recovery.armClock();
      const id = setInterval(() => {
        if (s.controlOnly() || !s.cast.receiverPlays(s.mediaFileId())) return;
        recovery.tickClockWatch();
        recovery.checkStall();
      }, 1000);
      onCleanup(() => clearInterval(id));
    },
    { injector },
  );
  injector.get(DestroyRef).onDestroy(() => {
    s.destroyed = true;
    recovery.dispose();
  });
  return recovery;
}
