import { powerSaveBlocker } from 'electron';

// mpv renders outside the web contents (vo=libmpv / --wid), so Chromium's media
// wake-lock never engages and the OS dims/sleeps mid-playback — the main process
// must inhibit sleep itself. One blocker for the app's single player session.
let blockerId: number | null = null;

/** Hold a `prevent-display-sleep` blocker while playing, release it otherwise. */
export function setPlaybackKeepAwake(active: boolean): void {
  const held = blockerId !== null && powerSaveBlocker.isStarted(blockerId);
  if (active === held) return;
  if (active) {
    blockerId = powerSaveBlocker.start('prevent-display-sleep');
  } else {
    if (blockerId !== null) powerSaveBlocker.stop(blockerId);
    blockerId = null;
  }
}

/** True while playing or buffering — both mean an active session that must not
 *  let the screen sleep; paused / idle / ended / error release it. */
export function keepAwakeForState(state: string | undefined): boolean {
  return state === 'playing' || state === 'buffering';
}
