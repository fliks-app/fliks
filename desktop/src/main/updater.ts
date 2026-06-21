import { app, BrowserWindow, ipcMain, shell } from 'electron';
import electronUpdater from 'electron-updater';
import {
  UPDATE_IPC,
  type DesktopUpdateCapability,
  type DesktopUpdateInfo,
  type DesktopUpdateStatus,
} from '../shared/contract';

const { autoUpdater } = electronUpdater;

// Public repo → the GitHub releases API and page need no token. Overridable for
// forks / test repos (mirrors the backend's FLIKS_GITHUB_REPO).
const GITHUB_REPO = process.env.FLIKS_GITHUB_REPO ?? 'fliks-app/fliks';
const RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases`;

// Re-check periodically while the app stays open, plus once shortly after launch.
const INITIAL_CHECK_DELAY_MS = 10_000;
const PERIODIC_CHECK_MS = 6 * 60 * 60 * 1000;

/** electron-updater can self-install only from an NSIS exe (Windows), a signed
 *  .app via a zip (macOS), or an AppImage (Linux). A .deb has no in-place update
 *  path (dpkg needs root), and dev runs aren't packaged. Those fall back to a
 *  "download from the releases page" flow. */
function canSelfInstall(): boolean {
  if (!app.isPackaged) return false;
  if (process.platform === 'linux') return !!process.env.APPIMAGE;
  return true;
}

function capability(): DesktopUpdateCapability {
  return {
    canInstall: canSelfInstall(),
    currentVersion: app.getVersion(),
    releasesUrl: RELEASES_URL,
  };
}

/** electron-updater's release notes can be a string or an array of
 *  {version, note} blocks (fullChangelog). Flatten to plain text/HTML. */
function normalizeNotes(notes: unknown): string | null {
  if (!notes) return null;
  if (typeof notes === 'string') return notes;
  if (Array.isArray(notes)) {
    return notes
      .map((n) => (n && typeof n === 'object' && 'note' in n ? String((n as { note: unknown }).note ?? '') : ''))
      .filter(Boolean)
      .join('\n\n');
  }
  return null;
}

/**
 * Wires the in-app updater: registers the renderer-invokable channels
 * (check/install/openReleases/getCapability) and broadcasts status updates so
 * the Angular AppUpdateService can drive the update button + modal.
 *
 * On installable builds it uses electron-updater (autoDownload off so the user
 * confirms in the modal); on a .deb or in dev it does a lightweight GitHub
 * release lookup just to surface availability + a download link.
 */
export function setupUpdater(): void {
  const installable = canSelfInstall();

  const broadcast = (status: DesktopUpdateStatus): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(UPDATE_IPC.status, status);
    }
  };

  ipcMain.handle(UPDATE_IPC.getCapability, () => capability());
  ipcMain.handle(UPDATE_IPC.openReleases, () => shell.openExternal(RELEASES_URL));

  if (installable) {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    // Differential downloads pull in lzma-native (a native module that isn't
    // bundled); full-file downloads avoid it and are fine for our installer sizes.
    autoUpdater.disableDifferentialDownload = true;

    const toInfo = (u: electronUpdater.UpdateInfo): DesktopUpdateInfo => ({
      version: u.version,
      releaseName: u.releaseName ?? null,
      releaseNotes: normalizeNotes(u.releaseNotes),
      releaseDate: u.releaseDate ?? null,
      releaseUrl: `${RELEASES_URL}/tag/v${u.version}`,
    });

    autoUpdater.on('checking-for-update', () => broadcast({ state: 'checking' }));
    autoUpdater.on('update-available', (u) => broadcast({ state: 'available', info: toInfo(u) }));
    autoUpdater.on('update-not-available', () => broadcast({ state: 'not-available' }));
    autoUpdater.on('download-progress', (p) =>
      broadcast({ state: 'downloading', percent: Math.round(p.percent) }),
    );
    autoUpdater.on('update-downloaded', (u) => {
      broadcast({ state: 'downloaded', info: toInfo(u) });
      // Quit and apply the update. autoInstallOnAppQuit also covers a normal quit.
      autoUpdater.quitAndInstall();
    });
    autoUpdater.on('error', (e) =>
      broadcast({ state: 'error', message: e?.message ?? String(e) }),
    );

    ipcMain.handle(UPDATE_IPC.check, () =>
      autoUpdater.checkForUpdates().catch((e) => {
        broadcast({ state: 'error', message: (e as Error)?.message ?? String(e) });
      }),
    );
    ipcMain.handle(UPDATE_IPC.install, () =>
      autoUpdater.downloadUpdate().catch((e) => {
        broadcast({ state: 'error', message: (e as Error)?.message ?? String(e) });
      }),
    );
  } else {
    // .deb / dev: detect-only via the public GitHub release, install = open page.
    ipcMain.handle(UPDATE_IPC.check, () => githubFallbackCheck(broadcast));
    ipcMain.handle(UPDATE_IPC.install, () => shell.openExternal(RELEASES_URL));
  }

  // Kick an initial check shortly after launch, then on a long interval.
  const check = (): void => {
    const fn = installable ? () => autoUpdater.checkForUpdates() : () => githubFallbackCheck(broadcast);
    Promise.resolve(fn()).catch((e) =>
      console.warn('[updater] check failed', (e as Error)?.message ?? e),
    );
  };
  setTimeout(check, INITIAL_CHECK_DELAY_MS);
  setInterval(check, PERIODIC_CHECK_MS);
}

function parseVersion(raw: string | null | undefined): number[] | null {
  if (!raw) return null;
  const core = raw.trim().replace(/^v/i, '').split(/[-+]/)[0];
  const parts = core.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length === 0 || parts.some((n) => Number.isNaN(n))) return null;
  return parts;
}

function isNewer(latest: string | null, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const l = a[i] ?? 0;
    const c = b[i] ?? 0;
    if (l > c) return true;
    if (l < c) return false;
  }
  return false;
}

/** Detect-only update check for builds electron-updater can't self-install. */
async function githubFallbackCheck(
  broadcast: (s: DesktopUpdateStatus) => void,
): Promise<void> {
  broadcast({ state: 'checking' });
  const controller = new AbortController();
  // Generous ceiling for a cold TLS handshake to api.github.com (the check is
  // async + retried on the periodic timer, so a long timeout is harmless).
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'fliks-desktop' },
        signal: controller.signal,
      },
    );
    if (!res.ok) {
      broadcast({ state: 'not-available' });
      return;
    }
    const release = (await res.json()) as {
      tag_name?: string;
      name?: string;
      html_url?: string;
      body?: string;
      published_at?: string;
    };
    const latest = release.tag_name ?? release.name ?? null;
    if (isNewer(latest, app.getVersion())) {
      broadcast({
        state: 'available',
        info: {
          version: (latest ?? '').replace(/^v/i, ''),
          releaseName: release.name ?? null,
          releaseNotes: release.body ?? null,
          releaseDate: release.published_at ?? null,
          releaseUrl: release.html_url ?? RELEASES_URL,
        },
      });
    } else {
      broadcast({ state: 'not-available' });
    }
  } catch (e) {
    broadcast({ state: 'error', message: (e as Error)?.message ?? String(e) });
  } finally {
    clearTimeout(timer);
  }
}
