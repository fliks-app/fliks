const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
app.commandLine.appendSwitch('ozone-platform', 'x11');
app.whenReady().then(() => {
  const addon = require('./build/Release/fliks_compositor.node');
  addon.start({ width: 1280, height: 720, title: 'FLIKS_COMPOSITOR' });

  const counts = {};
  let lastTime = -1;
  addon.onEvent((json) => {
    let ev;
    try { ev = JSON.parse(json); } catch { return; }
    counts[ev.type] = (counts[ev.type] || 0) + 1;
    if (ev.type === 'timeUpdate') lastTime = ev.position;
    if (ev.type === 'firstFrame' || ev.type === 'stateChanged') console.log('[event]', json);
  });

  const win = new BrowserWindow({ width: 1280, height: 720, show: false, transparent: true, backgroundColor: '#00000000', webPreferences: { offscreen: true } });
  win.webContents.setFrameRate(30);
  const html = `<body style="margin:0;width:1280px;height:720px;background:transparent;font-family:sans-serif;overflow:hidden">
    <div style="position:absolute;top:16px;left:16px;padding:8px 14px;background:rgba(29,35,42,.78);color:#fff;border-radius:10px;font-weight:600">Fliks compositor (events + headers)</div>
    <div style="position:absolute;left:0;right:0;bottom:0;height:90px;background:linear-gradient(to top,rgba(0,0,0,.85),transparent);display:flex;align-items:center;gap:16px;padding:0 24px;box-sizing:border-box">
      <div style="width:54px;height:54px;border-radius:50%;background:#36d399"></div>
      <div style="flex:1;height:6px;border-radius:3px;background:rgba(255,255,255,.3);position:relative"><i style="position:absolute;left:0;top:0;bottom:0;width:40%;background:#36d399;border-radius:3px"></i></div>
      <span style="color:#fff">12:34</span>
    </div></body>`;
  win.loadURL('data:text/html,' + encodeURIComponent(html));
  win.webContents.on('paint', (e, dirty, image) => {
    const sz = image.getSize();
    addon.uploadUi(image.getBitmap(), sz.width, sz.height);
  });

  setTimeout(() => addon.load({ url: '/tmp/fliks-gate4.mp4' }), 800);
  setTimeout(() => {
    console.log('[test] event counts:', JSON.stringify(counts), 'lastTime=', lastTime.toFixed(2));
    const cmd = 'W=$(xwininfo -root -tree -display :0 2>/dev/null | grep -i FLIKS_COMPOSITOR | grep -oE "0x[0-9a-f]+" | head -1); import -display :0 -window "$W" /tmp/fliks-gate4.png 2>&1 | head -1';
    spawn('sh', ['-c', cmd], { env: process.env, stdio: 'inherit' }).on('exit', () => { addon.stop(); app.quit(); });
  }, 5000);
});
