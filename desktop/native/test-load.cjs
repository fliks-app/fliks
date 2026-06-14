const { app } = require('electron');
app.whenReady().then(() => {
  try {
    const addon = require('./build/Release/fliks_compositor.node');
    console.log('[addon-load]', addon.hello());
  } catch (e) {
    console.error('[addon-load] FAILED:', e.message);
  }
  app.quit();
});
