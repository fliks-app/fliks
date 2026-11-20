import dbus from 'dbus-native';

/** Whether something on the session bus draws tray icons (GNOME shows none without an AppIndicator extension). */
export async function hasStatusNotifierHost(): Promise<boolean> {
  if (process.platform !== 'linux') return true;
  const bus = dbus.sessionBus();
  bus.on('error', () => {});
  try {
    return await bus.nameHasOwner('org.kde.StatusNotifierWatcher');
  } catch {
    return false;
  } finally {
    await bus.close().catch(() => {});
  }
}
