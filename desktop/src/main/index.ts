import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { registerAppSchemePrivileged, registerAppProtocol, APP_URL } from './protocol';
import { installCorsBypass } from './cors';
import { setupUpdater } from './updater';
import { setPlaybackKeepAwake, keepAwakeForState } from './power';
import { IPC, type DesktopEvent, type DesktopSubtitleStyle } from '../shared/contract';
import { mpvSubtitleProps } from './mpv/subtitle-style';

// Name the app before `ready` so Linux derives the WM class (and thus the
// GNOME/Ubuntu top-bar + dock identity) from "Fliks" rather than "Electron".
app.setName('Fliks');

// Linux uses the software OSR compositor (Chromium's GPU process can't init in
// that path, and a GPU-composited OSR window never recovers from a GPU-process
// crash), forced onto X11/XWayland. macOS/Windows use a normal GPU window with
// mpv embedded natively, so they keep hardware acceleration.
if (process.platform === 'linux') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('ozone-platform', 'x11');
}
registerAppSchemePrivileged();

process.on('uncaughtException', (e) => console.error('[main:uncaughtException]', e?.stack ?? e));
process.on('unhandledRejection', (e) => console.error('[main:unhandledRejection]', e));

// The desktop client connects to the user's self-hosted Fliks server, which
// commonly uses a self-signed or private-CA TLS certificate the OS doesn't
// trust — Chromium would otherwise refuse the HTTPS connection. Accept cert
// errors: the app only ever loads its own fliks:// UI and talks to the server
// the user explicitly configured (same trust model as the mobile apps).
app.on('certificate-error', (event, _wc, _url, _error, _cert, callback) => {
  event.preventDefault();
  callback(true);
});

const WIDTH = 1280;
const HEIGHT = 800;

// The native compositor addon (single SDL/GLES window: mpv video + OSR UI).
// Loaded via a real require so esbuild leaves the .node resolution to runtime.
const nativeRequire = createRequire(__filename);
type Addon = {
  start(o: { width: number; height: number; title: string; icon?: string }): void;
  onEvent(cb: (json: string) => void): void;
  onInput(cb: (json: string) => void): void;
  uploadUi(buf: Buffer, w: number, h: number): void;
  load(o: { url: string; startTime?: number; headers?: Record<string, string>; subtitles?: unknown[] }): void;
  command(args: string[]): void;
  getProperty(name: string): string | null;
  setProperty(name: string, value: string): void;
  setFullscreen(enabled: boolean): void;
  stop(): void;
};

function webDir(): string {
  if (process.env.FLIKS_WEB_DIR) return process.env.FLIKS_WEB_DIR;
  if (app.isPackaged) return path.join(process.resourcesPath, 'web');
  return path.resolve(app.getAppPath(), '..', 'client', 'dist', 'client', 'browser');
}

// The Fliks logo for the dev (`electron .`) window. Packaged builds get their
// dock/launcher icon from electron-builder's `build/icon.*`, so this only needs
// to resolve when running unpackaged from `desktop/`. Returns undefined if the
// PNG is missing so Electron keeps its default rather than throwing.
function windowIcon(): string | undefined {
  const candidate = path.join(app.getAppPath(), 'build', 'icon.png');
  return fs.existsSync(candidate) ? candidate : undefined;
}

// The VISIBLE window is the native SDL compositor (the BrowserWindow above is
// offscreen), so the dock/taskbar icon comes from SDL_SetWindowIcon in the
// addon — not the BrowserWindow. SDL2's core loader reads BMP only, so the
// addon takes a .bmp. Empty string → addon keeps no icon (rather than crash).
function compositorIcon(): string {
  const candidate = path.join(app.getAppPath(), 'build', 'icon.bmp');
  return fs.existsSync(candidate) ? candidate : '';
}

const num = (v: string | null): number => {
  const n = v == null ? NaN : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

// Human host-OS name + version, resolved NATIVELY (the renderer's UA freezes the
// OS version, so it can't produce these). Computed once and cached.
let cachedSystemName: string | null = null;
function systemName(): string {
  if (cachedSystemName != null) return cachedSystemName;
  cachedSystemName = computeSystemName();
  return cachedSystemName;
}
function computeSystemName(): string {
  try {
    if (process.platform === 'darwin') {
      // os.release() is the Darwin kernel version; the marketing version comes
      // from sw_vers (e.g. "26.0" → "macOS 26").
      const v = execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim();
      const major = v.split('.')[0];
      return major ? `macOS ${major}` : 'macOS';
    }
    if (process.platform === 'win32') {
      // os.release() → "10.0.22631"; build ≥ 22000 is Windows 11.
      const build = parseInt(os.release().split('.')[2] ?? '0', 10);
      return build >= 22000 ? 'Windows 11' : 'Windows 10';
    }
    if (process.platform === 'linux') {
      // /etc/os-release PRETTY_NAME → "Ubuntu 24.04.1 LTS" → "Ubuntu 24.04".
      const txt = fs.readFileSync('/etc/os-release', 'utf8');
      const m = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(txt);
      if (m) {
        return m[1]
          .replace(/\s+LTS\b/i, '') // drop the LTS suffix
          .replace(/(\d+\.\d+)\.\d+/, '$1') // 24.04.1 → 24.04
          .trim();
      }
      return 'Linux';
    }
  } catch {
    /* fall through to the platform id */
  }
  return process.platform;
}

// User-assigned machine name ("MacBook de Clément"), resolved natively. Cached.
let cachedDeviceName: string | null = null;
function deviceName(): string {
  if (cachedDeviceName != null) return cachedDeviceName;
  cachedDeviceName = computeDeviceName();
  return cachedDeviceName;
}
function computeDeviceName(): string {
  try {
    if (process.platform === 'darwin') {
      // The friendly name set in System Settings ("MacBook de Clément"), not the
      // dotted local hostname.
      const name = execFileSync('scutil', ['--get', 'ComputerName'], {
        encoding: 'utf8',
      }).trim();
      if (name) return name;
    }
  } catch {
    /* fall through to hostname */
  }
  return os.hostname().replace(/\.local$/, '');
}

function parseTracks(json: string | null): {
  audioTracks: unknown[];
  subtitleTracks: unknown[];
} {
  let list: any[] = [];
  try {
    list = JSON.parse(json ?? '[]') ?? [];
  } catch {
    /* not ready */
  }
  const audioTracks: unknown[] = [];
  const subtitleTracks: unknown[] = [];
  for (const t of list) {
    if (t.type === 'audio')
      audioTracks.push({ id: String(t.id), language: t.lang ?? '', label: t.title ?? '', selected: !!t.selected });
    else if (t.type === 'sub')
      subtitleTracks.push({
        id: String(t.id),
        language: t.lang ?? '',
        label: t.title ?? '',
        forced: !!t.forced,
        selected: !!t.selected,
      });
  }
  return { audioTracks, subtitleTracks };
}

const KEYMAP: Record<string, string> = {
  Return: 'Enter',
  Backspace: 'Backspace',
  Tab: 'Tab',
  Escape: 'Escape',
  Space: 'Space',
  Left: 'Left',
  Right: 'Right',
  Up: 'Up',
  Down: 'Down',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
};

let uiWin: BrowserWindow | null = null;
const inputCounts: Record<string, number> = {};

// Cadence of the periodic position emit while playing. The addon only observes
// `time-pos` for duration/seek transitions, not as playback advances, so the
// renderer's seekbar and its 10s save heartbeat stay frozen unless the main
// process pushes the position itself. ~250ms (4Hz) keeps the bar smooth and
// feeds the renderer's per-second stats refresh without flooding IPC.
const POSITION_POLL_MS = 250;

function send(ev: DesktopEvent): void {
  if (uiWin && !uiWin.isDestroyed()) uiWin.webContents.send(IPC.event, ev);
}

function rendererUrl(haveApp: boolean): string {
  return haveApp ? APP_URL : 'data:text/html,<body style="background:%231d232a"></body>';
}

// Windows / macOS: a framed master window carries the native chrome; the video
// embeds into a frameless transparent window pinned over its content area, with
// the web UI in a second transparent window above that. Windows embeds an mpv
// subprocess via --wid; macOS embeds in-process libmpv (CAOpenGLLayer on the
// video window's NSView) — PlayerSession.createPlayer() picks the backend. See
// PlayerSession for why the frame and the see-through video layer are separate.
async function startEmbedSession(haveApp: boolean): Promise<void> {
  const { PlayerSession } = await import('./window/player-session');
  const { registerPlayerIpc } = await import('./ipc');
  const session = new PlayerSession();
  // Register the IPC handlers BEFORE start() loads the renderer + emits 'ready',
  // so the renderer can't invoke an unregistered channel.
  registerPlayerIpc(session);
  await session.start({
    rendererUrl: rendererUrl(haveApp),
    preloadPath: path.join(app.getAppPath(), 'dist', 'preload', 'index.cjs'),
    iconPath: windowIcon(),
  });
}

// Fallback for any platform without a playback backend (not Linux/Windows/macOS,
// which are all wired). Opens the web UI so the app launches + browses; playback
// IPC is intentionally not wired, so attempting to play surfaces a clear error.
async function startUiOnly(haveApp: boolean): Promise<void> {
  console.warn(`[main] playback not implemented on ${process.platform} — UI-only (needs a native libmpv compositor)`);
  uiWin = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    title: 'Fliks',
    icon: windowIcon(),
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist', 'preload', 'index.cjs'),
      contextIsolation: true,
      sandbox: false,
    },
  });
  uiWin.webContents.on('console-message', (_e, _l, m) => console.log('[renderer]', m));
  await uiWin.loadURL(rendererUrl(haveApp));
  send({ type: 'ready' });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);

  // macOS ignores a BrowserWindow's `icon`; the dock icon comes from the app
  // bundle when packaged, but a dev `electron .` run shows Electron's default.
  // Set it explicitly from build/icon.png so the dock shows the Fliks mark.
  if (process.platform === 'darwin' && app.dock) {
    const icon = windowIcon();
    if (icon) app.dock.setIcon(icon);
  }

  installCorsBypass();

  // Available on every platform path (embed / compositor / ui-only) so the
  // renderer can label this device with its real OS + version.
  ipcMain.handle(IPC.getSystemInfo, () => ({
    systemName: systemName(),
    deviceName: deviceName(),
  }));

  // In-app updater (electron-updater on installable builds, GitHub-release
  // detect-only on .deb/dev). Registered on every platform path so the renderer
  // can always query capability + listen for status.
  setupUpdater();

  const dir = webDir();
  const haveApp = fs.existsSync(path.join(dir, 'index.html'));
  if (haveApp) registerAppProtocol(dir);

  // Windows embeds an mpv subprocess (--wid) into the video window; macOS embeds
  // in-process libmpv (CAOpenGLLayer on the video window's NSView). Both use the
  // 3-window PlayerSession + the platform player factory in createPlayer().
  if (process.platform === 'win32' || process.platform === 'darwin') {
    await startEmbedSession(haveApp).catch((e) => console.error('[main] embed session failed', e));
    return;
  }
  if (process.platform !== 'linux') {
    await startUiOnly(haveApp).catch((e) => console.error('[main] ui-only failed', e));
    return;
  }

  // The .node addon and the dlopen'd libmpv are asarUnpack'd, so in a packaged
  // app they live under app.asar.unpacked — not inside app.asar (a file). The
  // addon require survives the asar path via Electron's shim, but libmpv is
  // dlopen'd natively (no shim) and must resolve to the unpacked path.
  const nativeBase = app.isPackaged
    ? app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked')
    : app.getAppPath();
  if (!process.env.FLIKS_MPV_PATH) {
    process.env.FLIKS_MPV_PATH = path.join(nativeBase, 'native', 'vendor', 'libmpv.so.2');
  }
  const addon = nativeRequire(
    path.join(nativeBase, 'native', 'build', 'Release', 'fliks_compositor.node'),
  ) as Addon;

  // The OFFSCREEN window renders the Angular UI to a transparent bitmap; the
  // addon's SDL window is the only visible surface.
  uiWin = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    title: 'Fliks',
    icon: windowIcon(),
    webPreferences: {
      offscreen: true,
      preload: path.join(app.getAppPath(), 'dist', 'preload', 'index.cjs'),
      contextIsolation: true,
      sandbox: false,
      // Trusted client → reach the user's server regardless of CORS/mixed
      // content (cors.ts still reflects ACAO). Same as the embed path + mobile.
      webSecurity: false,
    },
  });
  uiWin.webContents.setFrameRate(60);
  uiWin.webContents.on('paint', (_e, _dirty, image) => {
    const s = image.getSize();
    if (s.width > 0) addon.uploadUi(image.toBitmap(), s.width, s.height);
  });
  uiWin.webContents.on('console-message', (_e, _l, m) => console.log('[renderer]', m));

  addon.start({ width: WIDTH, height: HEIGHT, title: 'Fliks', icon: compositorIcon() });

  // Periodic position emit. The addon's `time-pos` observe doesn't push while
  // playback advances, so poll mpv on a timer and forward a `timeUpdate` — this
  // is what advances the seekbar and feeds the renderer's resume-save heartbeat.
  let positionTimer: ReturnType<typeof setInterval> | null = null;
  const emitPosition = (): void => {
    send({
      type: 'timeUpdate',
      payload: {
        position: num(addon.getProperty('time-pos')),
        duration: num(addon.getProperty('duration')),
        buffered: num(addon.getProperty('demuxer-cache-time')),
      },
    });
  };
  const startPositionTimer = (): void => {
    if (positionTimer) return; // idempotent — never stack intervals
    emitPosition(); // emit immediately so the bar doesn't wait a full tick
    positionTimer = setInterval(emitPosition, POSITION_POLL_MS);
  };
  const stopPositionTimer = (): void => {
    if (!positionTimer) return;
    clearInterval(positionTimer);
    positionTimer = null;
  };

  // mpv events → reshape to the DesktopEvent contract → renderer.
  addon.onEvent((json) => {
    let raw: any;
    try {
      raw = JSON.parse(json);
    } catch {
      return;
    }
    switch (raw.type) {
      case 'timeUpdate':
        // Read the real buffered position (matches the polled emitPosition).
        // Hardcoding 0 here made bufferedEnd flip 0 <-> real as these events
        // interleaved with the poll, so the seekbar's buffered zone flickered.
        send({
          type: 'timeUpdate',
          payload: {
            position: raw.position,
            duration: raw.duration,
            buffered: num(addon.getProperty('demuxer-cache-time')),
          },
        });
        break;
      case 'stateChanged':
        // Only an actively-playing session should drive the position timer;
        // pausing / ending / going idle stops it so a torn-down or paused
        // player can't keep emitting (and leaking the interval).
        if (raw.state === 'playing') startPositionTimer();
        else stopPositionTimer();
        setPlaybackKeepAwake(keepAwakeForState(raw.state));
        send({ type: 'stateChanged', payload: { state: raw.state } });
        break;
      case 'tracksChanged':
        send({ type: 'tracksChanged', payload: parseTracks(addon.getProperty('track-list')) as any });
        break;
      case 'firstFrame':
        // mpv autoplays on load (addon forces pause=no) but may not emit a
        // pause-property change, so the playing stateChanged can be missing on
        // a fresh load — arm the timer on the first frame as well.
        startPositionTimer();
        setPlaybackKeepAwake(true);
        send({ type: 'firstFrame' });
        break;
      case 'error':
        stopPositionTimer();
        setPlaybackKeepAwake(false);
        send({ type: 'error', payload: { code: -1, message: raw.message ?? 'error' } });
        break;
    }
  });

  // SDL input (the addon owns the visible window) → the offscreen webContents.
  addon.onInput((json) => {
    let i: any;
    try {
      i = JSON.parse(json);
    } catch {
      return;
    }
    if (!uiWin || uiWin.isDestroyed()) return;
    // Keep the OSR render size == the compositor window size so SDL input
    // coords map 1:1 to the offscreen webContents.
    if (i.kind === 'resize') {
      if (i.w > 0 && i.h > 0) uiWin.setContentSize(i.w, i.h);
      return;
    }
    inputCounts[i.kind] = (inputCounts[i.kind] || 0) + 1;
    if (inputCounts[i.kind] === 1 || (i.kind === 'move' && inputCounts.move % 60 === 0))
      console.log('[input]', i.kind, 'x=', i.x, 'y=', i.y, 'count=', inputCounts[i.kind]);
    const wc = uiWin.webContents;
    if (i.kind !== 'move' && i.kind !== 'wheel') wc.focus();
    if (i.kind === 'move') wc.sendInputEvent({ type: 'mouseMove', x: i.x, y: i.y } as any);
    else if (i.kind === 'button')
      wc.sendInputEvent({ type: i.down ? 'mouseDown' : 'mouseUp', x: i.x, y: i.y, button: i.button, clickCount: i.clicks || 1 } as any);
    else if (i.kind === 'wheel')
      wc.sendInputEvent({ type: 'mouseWheel', x: i.x, y: i.y, deltaX: i.dx * 40, deltaY: i.dy * 40, canScroll: true } as any);
    else if (i.kind === 'text') wc.sendInputEvent({ type: 'char', keyCode: i.text } as any);
    else if (i.kind === 'key') {
      const k = KEYMAP[i.key];
      if (k) wc.sendInputEvent({ type: i.down ? 'keyDown' : 'keyUp', keyCode: k } as any);
    }
  });

  // Route the renderer's player IPC to the addon (control via mpv properties).
  ipcMain.handle(IPC.load, (_e, opts) => {
    console.log('[ipc] load', opts?.url, 'start=', opts?.startTime, 'headers=', Object.keys(opts?.headers ?? {}).join(','));
    return addon.load(opts);
  });
  ipcMain.handle(IPC.play, () => addon.setProperty('pause', 'no'));
  ipcMain.handle(IPC.pause, () => addon.setProperty('pause', 'yes'));
  ipcMain.handle(IPC.seek, (_e, position: number) => addon.command(['seek', String(position), 'absolute']));
  ipcMain.handle(IPC.stop, () => {
    stopPositionTimer();
    return addon.command(['stop']);
  });
  ipcMain.handle(IPC.setPlaybackRate, (_e, r: number) => addon.setProperty('speed', String(r)));
  ipcMain.handle(IPC.setVolume, (_e, v: number) => addon.setProperty('volume', String(v)));
  ipcMain.handle(IPC.setMuted, (_e, m: boolean) => addon.setProperty('mute', m ? 'yes' : 'no'));
  ipcMain.handle(IPC.getPosition, () => ({
    position: num(addon.getProperty('time-pos')),
    duration: num(addon.getProperty('duration')),
    buffered: num(addon.getProperty('demuxer-cache-time')),
  }));
  ipcMain.handle(IPC.getAudioTracks, () => parseTracks(addon.getProperty('track-list')).audioTracks);
  ipcMain.handle(IPC.selectAudioTrack, (_e, id: string) => addon.setProperty('aid', id));
  ipcMain.handle(IPC.getSubtitleTracks, () => parseTracks(addon.getProperty('track-list')).subtitleTracks);
  ipcMain.handle(IPC.selectSubtitleTrack, (_e, id: string | null) => {
    if (id == null) {
      addon.setProperty('sid', 'no');
      addon.setProperty('sub-visibility', 'no');
    } else {
      addon.setProperty('sid', id);
      addon.setProperty('sub-visibility', 'yes');
    }
  });
  // Sidecar subtitle: mpv parses the VTT once and seeks within it natively, so
  // (unlike a single-segment HLS SUBTITLES rendition) cues don't re-inject and
  // stack on seek. `cached` makes mpv reuse an already-loaded track for the same
  // URL, so repeated picks of the same subtitle don't add duplicates.
  ipcMain.handle(IPC.subAdd, (_e, url: string, label: string, language: string) =>
    addon.command(['sub-add', url, 'cached', label ?? '', language ?? '']),
  );
  ipcMain.handle(IPC.setFullscreen, (_e, enabled: boolean) => addon.setFullscreen(enabled));
  ipcMain.handle(IPC.setSubtitleStyle, (_e, s: DesktopSubtitleStyle) => {
    if (!s) return;
    for (const [name, value] of mpvSubtitleProps(s)) addon.setProperty(name, value);
  });
  ipcMain.handle(IPC.resize, () => {});
  ipcMain.handle(IPC.destroy, () => {
    stopPositionTimer();
    return addon.command(['stop']);
  });

  uiWin.loadURL(haveApp ? APP_URL : 'data:text/html,<body style="background:%231d232a"></body>');
  uiWin.webContents.once('did-finish-load', () => send({ type: 'ready' }));

  app.on('before-quit', () => {
    stopPositionTimer();
    try {
      addon.stop();
    } catch {
      /* already stopped */
    }
  });
});

app.on('window-all-closed', () => app.quit());
