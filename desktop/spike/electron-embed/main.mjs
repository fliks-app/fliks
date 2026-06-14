// Spike: prove the desktop playback compositing on Electron.
//
// Architecture (the production target): TWO stacked, geometry-synced windows.
//   • videoWin (bottom): borderless, hosts mpv embedded via `--wid` — pure video.
//   • uiWin (top): transparent, frameless, always-on-top, hosts the web UI
//     (here a test overlay; in production the built Angular app). Its
//     transparent regions reveal the video below; opaque chrome (title,
//     control bar) composites on top.
//
// Single-window `--wid` embedding was rejected up front: on X11 the mpv child
// surface stacks ABOVE the Chromium content, hiding the UI. Two windows give a
// deterministic z-order and match the mobile model (native video behind a
// transparent UI layer).
//
// Run: DISPLAY=:0 npx electron spike/electron-embed/main.mjs --no-sandbox

import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Force the X11/XWayland backend so getNativeWindowHandle() yields an X11 XID
// that mpv --wid can embed into. (Native Wayland subsurface embedding is a
// later concern; X11 is the reliable spike path.)
app.commandLine.appendSwitch('ozone-platform', 'x11');

const BOUNDS = { x: 120, y: 90, width: 960, height: 540 };
const CLIP = path.join(os.tmpdir(), 'fliks-mpv-smoke.mp4'); // made by smoke-mpv.mjs

let videoWin;
let uiWin;
let mpv;

function xidFromHandle(buf) {
  // On X11, Electron's native handle buffer carries the window XID. Try the
  // common encodings and log them; the screenshot confirms which embedded.
  const u32 = buf.length >= 4 ? buf.readUInt32LE(0) : null;
  const u64 = buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : null;
  return { u32, u64 };
}

function createWindows() {
  videoWin = new BrowserWindow({
    ...BOUNDS,
    frame: false,
    backgroundColor: '#000000',
    title: 'FLIKS_VIDEO',
    webPreferences: { offscreen: false },
  });
  // Nothing to load in the video window — mpv paints it.
  videoWin.loadURL('data:text/html,<body style="margin:0;background:#000"></body>');

  uiWin = new BrowserWindow({
    ...BOUNDS,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    title: 'FLIKS_UI',
    parent: videoWin,
  });
  uiWin.setAlwaysOnTop(true, 'screen-saver');
  uiWin.loadFile(path.join(__dirname, 'overlay.html'));

  // Glue: keep the transparent UI exactly over the video window.
  const sync = () => uiWin?.setBounds(videoWin.getBounds());
  videoWin.on('move', sync);
  videoWin.on('resize', sync);

  videoWin.webContents.once('did-finish-load', () => {
    const handle = videoWin.getNativeWindowHandle();
    const { u32, u64 } = xidFromHandle(handle);
    console.log('[spike] videoWin handle bytes:', handle.toString('hex'));
    console.log('[spike] candidate XIDs → u32:', u32, 'u64:', u64);
    embedMpv(u32);
  });
}

function embedMpv(xid) {
  const sockPath = path.join(os.tmpdir(), `fliks-spike-mpv.sock`);
  const args = [
    `--wid=${xid}`,
    '--vo=gpu-next',
    '--hwdec=auto-safe',
    '--target-colorspace-hint=yes',
    '--loop-file=inf',
    '--no-config',
    '--no-terminal',
    '--keep-open=yes',
    `--input-ipc-server=${sockPath}`,
    CLIP,
  ];
  console.log('[spike] spawning mpv --wid into', xid);
  mpv = spawn('mpv', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  mpv.stdout.on('data', (d) => process.stdout.write(`[mpv] ${d}`));
  mpv.stderr.on('data', (d) => process.stderr.write(`[mpv!] ${d}`));
  mpv.on('exit', (c) => console.log('[spike] mpv exited', c));

  // Self-capture path (SPIKE_CAPTURE=1): let video + overlay settle, grab the
  // screen with grim, then quit — bounded run, no interactive display needed.
  if (process.env.SPIKE_CAPTURE === '1') {
    setTimeout(() => {
      const cmd =
        process.env.SPIKE_CAP_CMD ??
        'grim ' + (process.env.SPIKE_SHOT ?? '/tmp/fliks-spike.png');
      console.log('[spike] capture cmd:', cmd);
      const g = spawn('sh', ['-c', cmd], { env: process.env, stdio: 'inherit' });
      g.on('exit', (code) => {
        console.log('[spike] capture exited', code);
        mpv?.kill('SIGTERM');
        app.quit();
      });
    }, 4500);
  }
}

app.whenReady().then(createWindows);
app.on('window-all-closed', () => {
  mpv?.kill('SIGTERM');
  app.quit();
});
