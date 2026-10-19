import { appendLog, redactUrls } from '../log-file';
import { setPlaybackKeepAwake, keepAwakeForState } from '../power';
import type { PlayerBackend } from '../mpv/player-backend';
import type { DesktopEvent } from '../../shared/contract';

/** Reshape a backend's events onto the `DesktopEvent` channel, log the diagnostic ones and drive keep-awake. */
export function forwardPlayerEvents(
  mpv: PlayerBackend,
  emit: (event: DesktopEvent) => void,
  onFirstFrame?: () => void,
): void {
  mpv.on('log', (s: string) => {
    process.stderr.write(`[${Date.now()}][mpv] ${s}`);
    // Failure levels only: mpv's default `v` level logs every segment URL, and the write is synchronous.
    if (/^\[(error|fatal|warn)\]/.test(s)) appendLog(redactUrls(`[mpv] ${s.trimEnd()}`));
  });
  // Packaged builds have no console: these events go to the log file too (not timeUpdate, too frequent).
  mpv.on('exit', (e) => {
    const line = `[mpv] process exit ${JSON.stringify(e)}`;
    console.error(line);
    appendLog(line);
  });
  mpv.on('stateChanged', (p) => {
    console.log('[player] state:', p.state);
    appendLog(`[player] state: ${p.state}`);
    setPlaybackKeepAwake(keepAwakeForState(p.state));
    emit({ type: 'stateChanged', payload: p });
  });
  mpv.on('timeUpdate', (p) => emit({ type: 'timeUpdate', payload: p }));
  mpv.on('tracksChanged', (p) => {
    console.log('[player] tracks:', JSON.stringify(p));
    emit({ type: 'tracksChanged', payload: p });
  });
  mpv.on('firstFrame', () => {
    console.log('[player] firstFrame');
    appendLog('[player] firstFrame');
    setPlaybackKeepAwake(true);
    onFirstFrame?.();
    emit({ type: 'firstFrame' });
  });
  mpv.on('error', (p) => {
    const line = redactUrls(`[player] error: ${JSON.stringify(p)}`);
    console.log(line);
    appendLog(line);
    setPlaybackKeepAwake(false);
    emit({ type: 'error', payload: p });
  });
}
