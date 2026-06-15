import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { registerAppSchemePrivileged, registerAppProtocol, APP_URL } from './protocol';
import { installCorsBypass } from './cors';
import { IPC, type DesktopEvent, type DesktopSubtitleStyle } from '../shared/contract';

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

// Base subtitle size the app's fontScale presets multiply. mpv's own default
// (55) renders far too large in the compositor window, so we calibrate lower —
// at scale 1.0 this lands around a typical caption height once mpv scales it to
// the window.
const MPV_BASE_SUB_FONT_SIZE = 32;

/** Translate the app's subtitle style presets to mpv `sub-*` property pairs.
 *  Both the app and mpv use #AARRGGBB with 00 = transparent / FF = opaque, so
 *  colours pass through unchanged. `sub-ass-override=force` lets the app style
 *  win over a subtitle track's embedded ASS/SSA styling, matching the mobile
 *  native player. `background-box` draws the configured backdrop behind the
 *  text; with no backdrop we fall back to outline-and-shadow so the edge effect
 *  is what's visible. */
function mpvSubtitleProps(s: DesktopSubtitleStyle): Array<[string, string]> {
  const hasBox = !!s.backgroundColor && s.backgroundColor !== 'transparent';
  const props: Array<[string, string]> = [
    ['sub-ass-override', 'force'],
    ['sub-font-size', String(Math.round(MPV_BASE_SUB_FONT_SIZE * (s.fontScale || 1)))],
    ['sub-color', s.foregroundColor || '#FFFFFF'],
    ['sub-border-style', hasBox ? 'background-box' : 'outline-and-shadow'],
    ['sub-back-color', hasBox ? s.backgroundColor : '#00000000'],
    ['sub-pos', String(Math.max(0, Math.min(100, 100 - (s.bottomMarginPercent || 0))))],
  ];
  // Every branch sets outline-size / shadow-offset / blur explicitly: these are
  // sticky mpv properties, so a preset that omits one would inherit a stale
  // value from the previous preset.
  switch (s.edgeType) {
    case 'none':
      props.push(['sub-outline-size', '0'], ['sub-shadow-offset', '0'], ['sub-blur', '0']);
      break;
    case 'outline':
      props.push(
        ['sub-outline-size', '3'], ['sub-outline-color', '#FF000000'],
        ['sub-shadow-offset', '0'], ['sub-blur', '0'],
      );
      break;
    case 'raised':
      props.push(
        ['sub-outline-size', '1'], ['sub-outline-color', '#FF000000'],
        ['sub-shadow-offset', '1'], ['sub-shadow-color', '#FF000000'], ['sub-blur', '0'],
      );
      break;
    case 'drop_shadow':
    default:
      // A soft glow behind the text with NO directional offset — a blurred,
      // half-opacity black outline. The blur lands on the outline (not the
      // fill), so the glyphs stay crisp; the offset is zero, so there's no
      // displaced ghost copy. Opacity is kept low so it reads as a light shadow
      // rather than a dark band around the text.
      props.push(
        ['sub-outline-size', '1.5'], ['sub-outline-color', '#4D000000'],
        ['sub-shadow-offset', '0'], ['sub-shadow-color', '#00000000'], ['sub-blur', '0.5'],
      );
      break;
  }
  return props;
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

// Windows: a framed GPU window with mpv embedded natively (--wid) and a
// transparent child window for the web UI on top. UNTESTED on real Windows
// hardware — the --wid GPU surface may punch through the transparent overlay,
// and transparent-window resize/fullscreen behaviour needs on-device checks.
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

// macOS (and any other non-Linux/Windows): playback is NOT implemented yet —
// the SDL/GLES OSR compositor is Linux-only and mpv's subprocess --wid crashes
// on macOS, which needs an in-process libmpv compositor (a native addon, like
// Linux's). Open the web UI so the app launches + browses; playback IPC is
// intentionally not wired, so attempting to play surfaces a clear error.
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
  installCorsBypass();

  const dir = webDir();
  const haveApp = fs.existsSync(path.join(dir, 'index.html'));
  if (haveApp) registerAppProtocol(dir);

  if (process.platform === 'win32') {
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
        send({ type: 'timeUpdate', payload: { position: raw.position, duration: raw.duration, buffered: 0 } });
        break;
      case 'stateChanged':
        // Only an actively-playing session should drive the position timer;
        // pausing / ending / going idle stops it so a torn-down or paused
        // player can't keep emitting (and leaking the interval).
        if (raw.state === 'playing') startPositionTimer();
        else stopPositionTimer();
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
        send({ type: 'firstFrame' });
        break;
      case 'error':
        stopPositionTimer();
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
