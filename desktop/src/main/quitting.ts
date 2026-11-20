import { app, autoUpdater } from 'electron';

let quitting = false;
app.on('before-quit', () => (quitting = true));
// Squirrel.Mac closes the windows before before-quit when it installs an update.
if (process.platform === 'darwin' && !process.mas) autoUpdater.on('before-quit-for-update', () => (quitting = true));

/** The app is quitting: a window close must close, not hide. */
export const isQuitting = (): boolean => quitting;
