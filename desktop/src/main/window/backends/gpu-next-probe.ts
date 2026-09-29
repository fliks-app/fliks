import { BrowserWindow } from 'electron';
import { MpvPlayer } from '../../mpv/mpv-player';
import { readWindowHandle } from './types';

let cached: Promise<'gpu-next' | 'gpu'> | null = null;

const POLL_DEADLINE_MS = 3000;
const POLL_INTERVAL_MS = 100;

/** Whether gpu-next initialises here (old drivers / low D3D11 feature levels fail it
 *  silently), via a throwaway hidden mpv. Cached per process: only the first `mpvPath` counts. */
export function resolveWindowsVo(mpvPath: string): Promise<'gpu-next' | 'gpu'> {
  if (!cached) cached = probe(mpvPath);
  return cached;
}

async function probe(mpvPath: string): Promise<'gpu-next' | 'gpu'> {
  let win: BrowserWindow | undefined;
  let player: MpvPlayer | undefined;
  try {
    win = new BrowserWindow({ show: false, width: 64, height: 64 });
    await win.loadURL('data:text/html,<body></body>');
    const wid = readWindowHandle(win);
    player = new MpvPlayer({
      baseArgs: [`--wid=${wid}`, '--vo=gpu-next', '--force-window=yes'],
      mpvPath,
    });
    player.on('error', (e) => console.warn('[gpu-next-probe] mpv error', e));
    await player.start();
    const vo = await pollCurrentVo(player);
    return vo === 'gpu-next' ? 'gpu-next' : 'gpu';
  } catch (e) {
    console.warn('[gpu-next-probe] failed, assuming plain gpu', e);
    return 'gpu';
  } finally {
    await player?.destroy().catch(() => {});
    if (win && !win.isDestroyed()) win.destroy();
  }
}

// mpv creates the --force-window VO in its idle loop, after the IPC server is
// already accepting, so current-vo can still be unset on the first read.
async function pollCurrentVo(player: MpvPlayer): Promise<string | undefined> {
  const deadline = performance.now() + POLL_DEADLINE_MS;
  for (;;) {
    const vo = await player.getProperty<string>('current-vo').catch(() => undefined);
    if (vo) return vo;
    if (performance.now() > deadline) return undefined;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}
