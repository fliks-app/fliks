const { app } = require('electron');
const { spawn } = require('child_process');
app.commandLine.appendSwitch('ozone-platform', 'x11');
app.whenReady().then(() => {
  let addon;
  try { addon = require('./build/Release/fliks_compositor.node'); }
  catch (e) { console.error('[load] FAIL', e.message); app.quit(); return; }
  console.log('[test] starting compositor window');
  addon.start({ width: 960, height: 540, title: 'FLIKS_COMPOSITOR' });
  setTimeout(() => {
    const cmd = 'echo "--- window ---"; xwininfo -root -tree -display :0 2>/dev/null | grep -i FLIKS_COMPOSITOR; '
      + 'W=$(xwininfo -root -tree -display :0 2>/dev/null | grep -i FLIKS_COMPOSITOR | grep -oE "0x[0-9a-f]+" | head -1); '
      + 'import -display :0 -window "$W" /tmp/fliks-compositor.png 2>&1 | head -1; ls -l /tmp/fliks-compositor.png 2>&1 | tail -1';
    const g = spawn('sh', ['-c', cmd], { env: process.env, stdio: 'inherit' });
    g.on('exit', () => { addon.stop(); app.quit(); });
  }, 3500);
});
