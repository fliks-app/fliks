// Spike step-1 gate: does Electron OSR with useSharedTexture emit a GPU shared
// texture (dmabuf on Linux/Intel) we can later import into our GL compositor?
// Logs the full shape of whatever the 'paint' event delivers, then quits.
//
// Run: DISPLAY=:0 ./node_modules/.bin/electron spike/osr-probe.mjs --no-sandbox

import { app, BrowserWindow } from 'electron';

app.commandLine.appendSwitch('ozone-platform', 'x11');

function dump(label, obj) {
  try {
    console.log(
      label,
      JSON.stringify(
        obj,
        (k, v) =>
          typeof v === 'bigint'
            ? `bigint:${v.toString()}`
            : Buffer.isBuffer(v)
              ? `buffer[${v.length}]:${v.toString('hex').slice(0, 32)}`
              : v,
        2,
      ),
    );
  } catch (e) {
    console.log(label, '(unserializable)', Object.keys(obj ?? {}));
  }
}

app.whenReady().then(() => {
  // FLIKS_OSR_SHARED=1 → GPU shared texture (zero-copy, needs working GPU
  // process); otherwise regular OSR → CPU bitmap in the paint event.
  const shared = process.env.FLIKS_OSR_SHARED === '1';
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: {
      offscreen: shared ? { useSharedTexture: true } : true,
    },
  });

  win.loadURL(
    'data:text/html,<body style="margin:0;background:linear-gradient(45deg,%23f00,%2300f)"><h1 style="color:%23fff;font-family:sans-serif">OSR probe</h1></body>',
  );

  let n = 0;
  win.webContents.on('paint', (...args) => {
    n++;
    if (n === 1) {
      console.log('[paint] arg count:', args.length);
      const ev = args[0];
      console.log('[paint] arg0 keys:', Object.keys(ev ?? {}));
      // Regular OSR: a NativeImage bitmap is delivered (event.image or arg[2]).
      const image = ev?.image ?? args.find((a) => a && typeof a.getSize === 'function');
      if (image && typeof image.getSize === 'function') {
        const sz = image.getSize();
        const bmp = image.getBitmap?.();
        console.log('[paint] CPU bitmap OK — size', JSON.stringify(sz), 'bytes', bmp?.length);
      } else {
        console.log('[paint] no CPU image on event');
      }
      const tex = ev?.texture ?? args.find((a) => a && a.textureInfo);
      if (tex) {
        console.log('[paint] texture keys:', Object.keys(tex));
        dump('[paint] texture.textureInfo:', tex.textureInfo ?? tex);
        try {
          tex.release();
          console.log('[paint] texture.release() ok');
        } catch (e) {
          console.log('[paint] release error:', e?.message);
        }
      } else {
        console.log('[paint] NO shared texture on event — useSharedTexture not active');
        dump('[paint] arg0:', ev);
      }
    }
    if (n >= 2) {
      app.quit();
    }
  });
  win.webContents.setFrameRate(8);

  // Safety: quit after a few seconds even if no paint arrives.
  setTimeout(() => {
    if (n === 0) console.log('[probe] no paint event in 6s');
    app.quit();
  }, 6000);
});
