const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
app.commandLine.appendSwitch('ozone-platform', 'x11');
app.whenReady().then(() => {
  const addon = require('./build/Release/fliks_compositor.node');
  addon.start({ width: 960, height: 540, title: 'FLIKS_COMPOSITOR' });
  const win = new BrowserWindow({ width: 960, height: 540, show: false, webPreferences: { offscreen: true } });
  win.webContents.setFrameRate(30);
  const html = `<body style="margin:0;width:960px;height:540px;background:#1d232a;font-family:sans-serif;overflow:hidden">
    <div style="position:absolute;top:0;left:0;width:140px;height:140px;background:red"></div>
    <div style="position:absolute;top:0;right:0;width:140px;height:140px;background:lime"></div>
    <div style="position:absolute;bottom:0;left:0;right:0;height:90px;background:blue"></div>
    <h1 style="color:#fff;position:absolute;top:210px;left:250px">FLIKS compositor UI ✓</h1></body>`;
  win.loadURL('data:text/html,' + encodeURIComponent(html));
  let painted = 0;
  win.webContents.on('paint', (e, dirty, image) => {
    painted++;
    const sz = image.getSize();
    addon.uploadUi(image.getBitmap(), sz.width, sz.height);
  });
  setTimeout(() => {
    console.log('[test] paint events:', painted);
    const cmd = 'W=$(xwininfo -root -tree -display :0 2>/dev/null | grep -i FLIKS_COMPOSITOR | grep -oE "0x[0-9a-f]+" | head -1); import -display :0 -window "$W" /tmp/fliks-gate3.png 2>&1 | head -1; ls -l /tmp/fliks-gate3.png 2>&1 | tail -1';
    spawn('sh', ['-c', cmd], { env: process.env, stdio: 'inherit' }).on('exit', () => { addon.stop(); app.quit(); });
  }, 5000);
});
