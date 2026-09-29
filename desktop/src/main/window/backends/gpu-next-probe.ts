import { BrowserWindow } from 'electron';
import { MpvPlayer } from '../../mpv/mpv-player';

let cached: Promise<'gpu-next' | 'gpu'> | null = null;

/**
 * Spawns a throwaway mpv embedded in a hidden window to see whether gpu-next
 * actually initialises (old drivers / low D3D11 feature levels fail it
 * silently; no error, just no video). Memoized per app session so the real
 * playback backend and the renderer's capability query always agree.
 */
export function resolveWindowsVo(mpvPath: string): Promise<'gpu-next' | 'gpu'> {
  if (!cached) cached = probe(mpvPath);
  return cached;
}

async function probe(mpvPath: string): Promise<'gpu-next' | 'gpu'> {
  const win = new BrowserWindow({ show: false, width: 64, height: 64 });
  await win.loadURL('data:text/html,<body></body>');
  const wid = win.getNativeWindowHandle().readUInt32LE(0);
  const player = new MpvPlayer({
    baseArgs: [`--wid=${wid}`, '--vo=gpu-next', '--force-window=yes'],
    mpvPath,
  });
  try {
    await player.start();
    // Core/VO init happens before the IPC server accepts connections, but give
    // a D3D11 device creation that's slow to fail a little more room.
    await new Promise((r) => setTimeout(r, 400));
    const vo = await player.getProperty<string>('current-vo');
    return vo === 'gpu-next' ? 'gpu-next' : 'gpu';
  } catch {
    return 'gpu';
  } finally {
    await player.destroy().catch(() => {});
    if (!win.isDestroyed()) win.destroy();
  }
}
