import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { registerAppSchemePrivileged, registerAppProtocol, APP_URL } from './protocol';
import { installCorsBypass } from './cors';
import { appendLog, echoRendererConsole, redactQuery } from './log-file';
import { setupUpdater } from './updater';
import { registerDownloadIpc } from './download';
import { registerCastIpc } from './cast';
import { IPC, type DesktopEvent, type DesktopMediaMetadata } from '../shared/contract';
import { LinuxCompositorPlayer, type CompositorAddon } from './mpv/linux-compositor-player';
import { forwardPlayerEvents } from './window/forward-events';
import { registerPlayerIpc } from './ipc';
import { toElectronKey } from './keymap';
import { watchRendererCrash } from './renderer-recovery';

// Velopack's install/update/uninstall hooks run and exit here, before any Electron startup.
if (process.platform === 'win32') {
  (require('velopack') as typeof import('velopack')).VelopackApp.build().run();
  // Matches the --aumid the Velopack shortcuts carry (desktop-release.yml).
  app.setAppUserModelId('media.fliks.desktop');
}

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
// A second instance would open the same Chromium profile, whose Local Storage
// is already locked: it boots with no server and no session.
if (!app.requestSingleInstanceLock()) app.exit(0);

// The UI only ever opens outside links (a trailer, a release page). A child
// BrowserWindow would inherit the parent's offscreen prefs and never be seen.
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
});
registerAppSchemePrivileged();

process.on('uncaughtException', (e) => console.error('[main:uncaughtException]', e?.stack ?? e));
process.on('unhandledRejection', (e) => console.error('[main:unhandledRejection]', e));

// The desktop client connects to the user's self-hosted Fliks server, which
// commonly uses a self-signed or private-CA TLS certificate the OS doesn't
// trust — Chromium would otherwise refuse the HTTPS connection. Accept cert
// errors: the app only ever loads its own fliks:// UI and talks to the server
// the user explicitly configured (same trust model as the mobile apps).
app.on('certificate-error', (event, _wc, url, error, _cert, callback) => {
  // Logged before the accept: if this fires for the media host, a "TLS
  // failure" report has nothing to do with mpv's own verification at all.
  appendLog(`[tls] ${redactQuery(url)} ${error}`);
  event.preventDefault();
  callback(true);
});

const WIDTH = 1280;
const HEIGHT = 800;

// The native compositor addon (single SDL/GLES window: mpv video + OSR UI).
// Loaded via a real require so esbuild leaves the .node resolution to runtime.
const nativeRequire = createRequire(__filename);

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
  const candidate = path.join(app.getAppPath(), 'build', 'icons', '512x512.png');
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

// Chromium cursor name → index into the addon's SDL system-cursor table. These
// are Blink's legacy names, where "pointer" is the plain arrow and "hand" is
// what CSS calls cursor:pointer. Anything unlisted falls back to the arrow;
// SDL has no grab cursor, so the hand stands in for the drag handles.
const CURSOR_SHAPES: Record<string, number> = {
  hand: 1,
  grab: 1,
  grabbing: 1,
  text: 2,
  move: 3,
};

// SDL reports wheel notches, Chromium wants pixels. GTK's own convention is
// about 53px a notch, which reads sluggish against a browser's smooth scroll.
const WHEEL_PIXELS_PER_NOTCH = 100;

let uiWin: BrowserWindow | null = null;
// Set where the OS has a media session to feed (Linux MPRIS, macOS Now Playing, Windows SMTC).
let setOsMediaSession: ((meta: DesktopMediaMetadata | null) => Promise<void>) | null = null;
// The rate the page set on the player, for the same OS media session.
let setOsPlaybackRate: ((rate: number) => void) | null = null;
const ipcHooks = { onPlaybackRate: (rate: number) => setOsPlaybackRate?.(rate) };
const inputCounts: Record<string, number> = {};

function send(ev: DesktopEvent): void {
  if (uiWin && !uiWin.isDestroyed()) uiWin.webContents.send(IPC.event, ev);
}

/** Feeds MPRIS from the player and the page's metadata; returns what withdraws the session. */
function startMpris(player: LinuxCompositorPlayer): () => void {
  let mpris: import('./mpris').Mpris | null = null;
  let artwork: string | null = null;
  let rate = 1;
  setOsPlaybackRate = (r) => {
    rate = r;
    mpris?.setRate(r);
  };
  const withdraw = () => {
    if (artwork) fs.rm(artwork, { force: true }, () => {});
    artwork = null;
    void mpris?.setMetadata(null);
  };
  setOsMediaSession = async (meta) => {
    if (!meta) return withdraw();
    try {
      if (!mpris) {
        const { Mpris } = await import('./mpris');
        mpris = new Mpris((keyCode) => {
          for (const type of ['keyDown', 'keyUp'] as const)
            uiWin?.webContents.sendInputEvent({ type, keyCode } as any);
        }, (position) => send({ type: 'seekRequest', payload: { position } }));
        mpris.setRate(rate);
        player.on('timeUpdate', (p) => mpris?.setPosition(p));
        player.on('stateChanged', ({ state }) => {
          if (state === 'playing') mpris?.setStatus('Playing');
          else if (state === 'paused') mpris?.setStatus('Paused');
          else if (state === 'ended' || state === 'idle' || state === 'error') mpris?.setStatus('Stopped');
        });
      }
      const artworkUrl = meta.artworkUrl ? await cacheArtwork(meta.artworkUrl) : undefined;
      if (artwork) fs.rm(artwork, { force: true }, () => {});
      artwork = artworkUrl ? fileURLToPath(artworkUrl) : null;
      await mpris.setMetadata({ ...meta, artworkUrl });
    } catch (e) {
      console.error('[mpris] unavailable', e);
    }
  };
  return withdraw;
}

/** The OS fetches artwork itself, without the page's session: hand it a local copy. */
async function cacheArtwork(url: string): Promise<string | undefined> {
  if (!uiWin || uiWin.isDestroyed()) return undefined;
  const res = await uiWin.webContents.session.fetch(url);
  if (!res.ok) return undefined;
  const file = path.join(os.tmpdir(), `fliks-artwork-${createHash('sha1').update(url).digest('hex')}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return pathToFileURL(file).href;
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
  registerPlayerIpc(session, ipcHooks);
  await session.start({
    rendererUrl: rendererUrl(haveApp),
    preloadPath: path.join(app.getAppPath(), 'dist', 'preload', 'index.cjs'),
    iconPath: windowIcon(),
  });
  await startNowPlaying(session).catch((e) => console.error('[now-playing] unavailable', e));
}

/** Feeds macOS Now Playing / Windows SMTC from the player and the page's metadata, and routes its remote commands to the page as media keys. */
async function startNowPlaying(session: import('./window/player-session').PlayerSession): Promise<void> {
  const { NowPlaying } = await import('./now-playing');
  const addon =
    process.platform === 'darwin'
      ? (await import('./mpv/mac-mpv-player')).loadMacAddon()
      : (await import('./smtc-win')).loadSmtcAddon(session.windowHandle);
  const nowPlaying = new NowPlaying(addon);
  const { player, uiContents } = session;
  let playing = false;
  player.on('stateChanged', ({ state }) => {
    playing = state === 'playing';
    nowPlaying.setState(state);
  });
  player.on('timeUpdate', (p) => nowPlaying.setPosition(p));
  const press = (keyCode: string) => {
    for (const type of ['keyDown', 'keyUp'] as const) uiContents.sendInputEvent({ type, keyCode } as any);
  };
  const KEYS: Record<string, string> = { toggle: 'MediaPlayPause', stop: 'MediaStop', next: 'MediaNextTrack', previous: 'MediaPreviousTrack' };
  addon.onRemoteCommand((name, position = 0) => {
    if (name === 'seek') {
      uiContents.send(IPC.event, { type: 'seekRequest', payload: { position } } satisfies DesktopEvent);
      return;
    }
    // Electron has no play-only / pause-only key: a play while playing (or the reverse) is a no-op.
    if (name === 'play' ? !playing : name === 'pause' ? playing : true) press(KEYS[name] ?? 'MediaPlayPause');
  });
  setOsPlaybackRate = (rate) => nowPlaying.setRate(rate);
  setOsMediaSession = async (meta) => {
    try {
      const res = meta?.artworkUrl ? await uiContents.session.fetch(meta.artworkUrl) : null;
      nowPlaying.setMetadata(meta, res?.ok ? Buffer.from(await res.arrayBuffer()) : undefined);
    } catch (e) {
      console.error('[now-playing] unavailable', e);
    }
  };
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
      sandbox: true,
    },
  });
  echoRendererConsole(uiWin.webContents);
  await uiWin.loadURL(rendererUrl(haveApp));
  send({ type: 'ready' });
}

app.whenReady().then(async () => {
  // macOS needs the menu for Cmd+C/V/A/Z/Q; Windows and Linux have none.
  Menu.setApplicationMenu(
    process.platform === 'darwin'
      ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }])
      : null,
  );

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

  ipcMain.handle(IPC.openCalendarEvent, async (_e, ics: string, fileName: string) => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fliks-cal-'));
    const file = path.join(dir, path.basename(fileName));
    await fs.promises.writeFile(file, ics);
    const err = await shell.openPath(file);
    if (err) throw new Error(err);
  });

  ipcMain.handle(IPC.setMediaSession, (_e, meta: DesktopMediaMetadata | null) => setOsMediaSession?.(meta));

  ipcMain.handle(IPC.getPlayerCapabilities, async () => {
    const { getPlayerCapabilities } = await import('./window/backends/capabilities');
    return getPlayerCapabilities();
  });

  // In-app updater (electron-updater on installable builds, GitHub-release
  // detect-only on .deb/dev). Registered on every platform path so the renderer
  // can always query capability + listen for status.
  setupUpdater();

  // Offline downloads (renderer→main fetch-to-disk). Registered on every
  // platform path so the desktop download UI works regardless of playback backend.
  registerDownloadIpc();

  // Chromecast sender (mDNS discovery + CASTV2). Electron carries no Cast SDK —
  // the web sender's cast_sender.js needs Chrome's media router — so the
  // protocol is spoken from the main process. Registered on every platform path.
  registerCastIpc();

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
  ) as CompositorAddon;

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
      sandbox: true,
      // Trusted client → reach the user's server regardless of CORS/mixed
      // content (cors.ts still reflects ACAO). Same as the embed path + mobile.
      webSecurity: false,
    },
  });
  uiWin.webContents.setFrameRate(60);
  // The window is never shown, so Electron's focus() is a no-op on it and
  // Chromium keeps the widget unfocused: no blinking caret in any text field.
  // Focus emulation is the one switch that sets it without a visible window.
  const wcUi = uiWin.webContents;
  const enableFocusEmulation = () => {
    try {
      if (!wcUi.debugger.isAttached()) wcUi.debugger.attach('1.3');
      void wcUi.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {
        enabled: true,
      });
    } catch (e) {
      console.error('[main] focus emulation unavailable, the caret will not blink', e);
    }
  };
  enableFocusEmulation();
  // The crash detaches the debugger session: re-arm it for the reloaded page.
  uiWin.webContents.on('did-finish-load', enableFocusEmulation);
  // Chromium resolves the CSS cursor for the offscreen page and reports it
  // here; the pointer it applies to belongs to the compositor's window.
  uiWin.webContents.on('cursor-changed', (_e, type) => addon.setCursorShape(CURSOR_SHAPES[type] ?? 0));
  uiWin.webContents.on('paint', (_e, dirty, image) => {
    const { width, height } = image.getSize();
    if (width <= 0) return;
    // Offscreen paints at device scale 1, so the dirty rect is in bitmap pixels.
    addon.uploadUi(image.crop(dirty).toBitmap(), width, height, dirty.x, dirty.y, dirty.width, dirty.height);
  });
  echoRendererConsole(uiWin.webContents);

  const player = new LinuxCompositorPlayer(addon, {
    width: WIDTH,
    height: HEIGHT,
    title: 'Fliks',
    icon: compositorIcon(),
  });
  forwardPlayerEvents(player, send);
  await player.start();
  const stopOsMediaSession = startMpris(player);
  watchRendererCrash(uiWin.webContents, {
    appUrl: rendererUrl(haveApp),
    stopPlayback: async () => {
      stopOsMediaSession();
      await player.stop();
    },
    log: appendLog,
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
    else if (i.kind === 'button') {
      // sendInputEvent only knows left/middle/right, so the thumb buttons are
      // history moves here. Chromium's session history is what the router
      // listens to, so this behaves like a browser's back button.
      const history = wc.navigationHistory;
      if (i.button === 'back') {
        if (i.down && history.canGoBack()) history.goBack();
      } else if (i.button === 'forward') {
        if (i.down && history.canGoForward()) history.goForward();
      } else {
        wc.sendInputEvent({ type: i.down ? 'mouseDown' : 'mouseUp', x: i.x, y: i.y, button: i.button, clickCount: i.clicks || 1 } as any);
      }
    }
    else if (i.kind === 'wheel')
      wc.sendInputEvent({
        type: 'mouseWheel',
        x: i.x,
        y: i.y,
        deltaX: i.dx * WHEEL_PIXELS_PER_NOTCH,
        deltaY: i.dy * WHEEL_PIXELS_PER_NOTCH,
        canScroll: true,
      } as any);
    else if (i.kind === 'text') wc.sendInputEvent({ type: 'char', keyCode: i.text } as any);
    else if (i.kind === 'key') {
      const k = toElectronKey(i.key, i.mod | 0);
      if (k) wc.sendInputEvent({ type: i.down ? 'keyDown' : 'keyUp', ...k } as any);
    }
  });

  registerPlayerIpc({
    player,
    setFullscreen: (enabled) => addon.setFullscreen(enabled),
    setCursorVisible: (visible) => addon.setCursorVisible(visible),
    resize: () => {},
    destroy: () => player.destroy(),
    onStop: stopOsMediaSession,
  }, ipcHooks);

  uiWin.loadURL(haveApp ? APP_URL : 'data:text/html,<body style="background:%231d232a"></body>');
  uiWin.webContents.once('did-finish-load', () => send({ type: 'ready' }));

  app.on('before-quit', () => {
    try {
      addon.stop();
    } catch {
      /* already stopped */
    }
  });
});

app.on('window-all-closed', () => app.quit());
