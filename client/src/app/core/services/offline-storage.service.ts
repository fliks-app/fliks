import { Injectable, inject } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { AuthService } from './auth.service';
import { DownloadNotificationService } from './download-notification.service';
import { DownloadCacheService } from './download-cache.service';
import { desktopDownloaderOrNull } from '../plugins/desktop-downloader.bridge';

const CACHE_NAME = 'offline-media';

/** Map mediaFileId → Shaka offline:xxx URI. Persisted in localStorage, keyed
 *  per (server, user) like the rest of the download state. */
const SHAKA_OFFLINE_KEY = 'fliks.shakaOfflineUris';

/** Lazy-loaded Filesystem reference — avoids crash on web where the plugin isn't available. */
let _fs: typeof import('@capacitor/filesystem') | null = null;
async function getFs() {
  if (!_fs) _fs = await import('@capacitor/filesystem');
  return _fs;
}

/** Lazy-loaded Shaka: eager import adds ~750 KB to the initial bundle for a path only the downloads page uses (never native). */
let _shaka: typeof import('shaka-player').default | null = null;
async function getShaka() {
  if (!_shaka) _shaka = (await import('shaka-player')).default;
  return _shaka;
}

@Injectable({ providedIn: 'root' })
export class OfflineStorageService {
  private readonly isNative = Capacitor.isNativePlatform();
  private readonly platform = Capacitor.getPlatform();
  private readonly auth = inject(AuthService);
  private readonly notif = inject(DownloadNotificationService);
  private readonly cache = inject(DownloadCacheService);
  /** Electron desktop offline backend: files on disk, played back via mpv. */
  private readonly downloader = desktopDownloaderOrNull();
  private get isDesktop(): boolean {
    return !!this.downloader;
  }

  private mfidFromKey(key: string): string {
    return key.replace('download-', '');
  }

  /** Per (server, user) key for the Shaka offline URI map. */
  private shakaKey(): string {
    return `${SHAKA_OFFLINE_KEY}.${this.cache.scopeSuffix()}`;
  }

  async getLocalUrl(key: string): Promise<string | null> {
    if (this.isDesktop) {
      return this.downloader!.getLocalUrl(this.mfidFromKey(key));
    }
    if (this.isNative) {
      return this.getNativeOfflineUrl(key);
    }
    // Web: check Shaka offline URI (stored in localStorage)
    const mfid = key.replace('download-', '');
    const offlineUri = this.getShakaOfflineUri(Number(mfid));
    return offlineUri ?? null;
  }

  /** Resolves the playable offline source: iOS loads a local `.movpkg` whose path is resolved fresh (survives container-path changes),
   * Android replays the remote HLS URL stored on the DownloadTask through ExoPlayer's cache. */
  private async getNativeOfflineUrl(key: string): Promise<string | null> {
    try {
      const mfid = Number(key.replace('download-', ''));
      const task = this.cache
        .load()
        .find((t) => t.mediaFileId === mfid && t.status === 'ready');
      if (!task) return null;
      if (this.platform === 'ios') {
        return await this.notif.getOfflineUrl(String(task.id));
      }
      return task.hlsUrl ?? null;
    } catch {
      return null;
    }
  }

  // --- Shaka offline storage (web only) ---

  /** Get stored Shaka offline URI for a media file, or null. */
  getShakaOfflineUri(mediaFileId: number): string | null {
    try {
      const map = JSON.parse(localStorage.getItem(this.shakaKey()) ?? '{}');
      return map[String(mediaFileId)] ?? null;
    } catch {
      return null;
    }
  }

  private setShakaOfflineUri(mediaFileId: number, uri: string): void {
    try {
      const map = JSON.parse(localStorage.getItem(this.shakaKey()) ?? '{}');
      map[String(mediaFileId)] = uri;
      localStorage.setItem(this.shakaKey(), JSON.stringify(map));
    } catch { /* ignore */ }
  }

  private removeShakaOfflineUri(mediaFileId: number): void {
    try {
      const map = JSON.parse(localStorage.getItem(this.shakaKey()) ?? '{}');
      delete map[String(mediaFileId)];
      localStorage.setItem(this.shakaKey(), JSON.stringify(map));
    } catch { /* ignore */ }
  }

  /** Downloads an HLS stream into IndexedDB via Shaka offline storage; returns the `offline:` URI, or null on failure. */
  async shakaStore(
    hlsUrl: string,
    mediaFileId: number,
    meta: { title: string; episode?: string },
    onProgress?: (progress: number) => void,
  ): Promise<string | null> {
    if (this.isNative) return null;

    // Create a temporary Shaka player for the storage API.
    const shaka = await getShaka();
    const video = document.createElement('video');
    video.style.display = 'none';
    document.body.appendChild(video);
    const player = new shaka.Player();
    await player.attach(video);

    // Configure auth header for segment fetches
    const token = this.auth.accessToken;
    if (token) {
      player.getNetworkingEngine()?.registerRequestFilter((_type: any, request: any) => {
        if (request.uris?.[0]?.includes('/api/')) {
          request.headers['Authorization'] = `Bearer ${token}`;
        }
      });
    }

    const storage = new shaka.offline.Storage(player);
    storage.configure({
      offline: {
        numberOfParallelDownloads: 1,
        progressCallback: (_content: any, progress: number) => {
          onProgress?.(progress);
        },
        // Shaka defaults to one audio track; keep every audio rendition plus the chosen video variant for the track picker.
        trackSelectionCallback: (tracks: any[]) => {
          const variants = tracks.filter((t) => t.type === 'variant');
          if (!variants.length) return tracks;
          const best = variants.reduce((a, b) =>
            (a.bandwidth ?? 0) >= (b.bandwidth ?? 0) ? a : b,
          );
          const seenAudioIds = new Set<number>();
          const selected = variants.filter((v) => {
            if (v.videoId !== best.videoId) return false;
            if (v.audioId == null) return true;
            if (seenAudioIds.has(v.audioId)) return false;
            seenAudioIds.add(v.audioId);
            return true;
          });
          return [...selected, ...tracks.filter((t) => t.type !== 'variant')];
        },
      },
    } as any);

    try {
      const op: any = storage.store(hlsUrl, { title: meta.title, episode: meta.episode ?? '' });
      // storage.store() returns an AbortableOperation — await its .promise
      const stored = await (op.promise ?? op);
      const offlineUri: string | undefined = stored?.offlineUri;
      if (offlineUri) {
        this.setShakaOfflineUri(mediaFileId, offlineUri);
      }
      return offlineUri ?? null;
    } finally {
      await storage.destroy();
      await player.destroy();
      video.remove();
    }
  }

  /** Remove Shaka offline content for a media file. */
  async shakaRemove(mediaFileId: number): Promise<void> {
    const uri = this.getShakaOfflineUri(mediaFileId);
    if (!uri) return;

    const shaka = await getShaka();
    const video = document.createElement('video');
    const player = new shaka.Player();
    await player.attach(video);
    const storage = new shaka.offline.Storage(player);
    try {
      await storage.remove(uri);
    } catch { /* already removed or not found */ }
    await storage.destroy();
    await player.destroy();
    video.remove();
    this.removeShakaOfflineUri(mediaFileId);
  }

  /** Bytes a completed download occupies, or null; each backend counts its own way (disk walk, cache tally, Shaka record, file). */
  async sizeBytes(key: string): Promise<number | null> {
    const mfid = Number(this.mfidFromKey(key));
    try {
      if (this.isDesktop) {
        const items = await this.downloader!.list();
        return items.find((i) => i.id === String(mfid))?.size ?? null;
      }
      if (this.isNative) {
        const task = this.cache
          .load()
          .find((t) => t.mediaFileId === mfid && t.status === 'ready');
        if (!task) return null;
        const bytes = await this.notif.getDownloadSize(String(task.id));
        return bytes > 0 ? bytes : null;
      }
      const uri = this.getShakaOfflineUri(mfid);
      if (!uri) return null;
      const shaka = await getShaka();
      const storage = new shaka.offline.Storage();
      try {
        const list = await storage.list();
        return list.find((c: { offlineUri: string | null }) => c.offlineUri === uri)?.size ?? null;
      } finally {
        await storage.destroy();
      }
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    if (this.isDesktop) return this.downloader!.remove(this.mfidFromKey(key));
    if (this.isNative) return this.deleteNative(key);
    // Web: remove Shaka offline content
    const mfid = Number(key.replace('download-', ''));
    await this.shakaRemove(mfid);
  }

  /** Downloads a small text file (VTT); true only when written, so callers never record a subtitle entry for a failed file. */
  async downloadSmallFile(url: string, key: string): Promise<boolean> {
    if (this.isDesktop) return this.downloader!.saveFile(key, url);
    try {
      // Downloads can finish hours after the 1h access token was minted, so use the long-lived stream token (as in the subtitle URL).
      const token = this.auth.streamToken() ?? this.auth.accessToken ?? '';
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) return false;
      const text = await response.text();
      if (!text) return false;

      if (this.isNative) {
        const { Filesystem, Directory } = await getFs();
        await this.ensureDir();
        await Filesystem.writeFile({
          path: `fliks-downloads/${key}`,
          data: text,
          directory: Directory.Data,
          encoding: 'utf8' as any,
        });
      } else {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(key, new Response(text, { headers: { 'Content-Type': 'text/vtt' } }));
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Remove a stored VTT subtitle (counterpart to {@link downloadSmallFile}). */
  async deleteSmallFile(key: string): Promise<void> {
    if (this.isDesktop) return this.downloader!.deleteFile(key);
    try {
      if (this.isNative) {
        const { Filesystem, Directory } = await getFs();
        await Filesystem.deleteFile({
          path: `fliks-downloads/${key}`,
          directory: Directory.Data,
        });
      } else {
        const cache = await caches.open(CACHE_NAME);
        await cache.delete(key);
      }
    } catch { /* already gone — fine */ }
  }

  /** Get small file content as text (for VTT). */
  async getSmallFileUrl(key: string): Promise<string | null> {
    if (this.isDesktop) return this.downloader!.fileUrl(key);
    if (this.isNative) {
      try {
        const { Filesystem, Directory } = await getFs();
        const result = await Filesystem.readFile({
          path: `fliks-downloads/${key}`,
          directory: Directory.Data,
          encoding: 'utf8' as any,
        });
        const blob = new Blob([result.data as string], { type: 'text/vtt' });
        return URL.createObjectURL(blob);
      } catch {
        return null;
      }
    } else {
      try {
        const cache = await caches.open(CACHE_NAME);
        const resp = await cache.match(key);
        if (!resp) return null;
        const blob = await resp.blob();
        return URL.createObjectURL(blob);
      } catch {
        return null;
      }
    }
  }

  /** Get native file URI for a small file (for ExoPlayer / mpv — not a blob URL). */
  async getSmallFileNativeUri(key: string): Promise<string | null> {
    if (this.isDesktop) return this.downloader!.fileUrl(key);
    if (!this.isNative) return this.getSmallFileUrl(key);
    try {
      const { Filesystem, Directory } = await getFs();
      // getUri only builds a path; confirm the file exists or the native player attaches a dead subtitle track.
      await Filesystem.stat({ path: `fliks-downloads/${key}`, directory: Directory.Data });
      const result = await Filesystem.getUri({
        path: `fliks-downloads/${key}`,
        directory: Directory.Data,
      });
      return result.uri; // file:///data/... — ExoPlayer can read this
    } catch {
      return null;
    }
  }

  async has(key: string): Promise<boolean> {
    if (this.isDesktop) return (await this.downloader!.getLocalUrl(this.mfidFromKey(key))) !== null;
    if (this.isNative) {
      // Native offline content — resolve via the platform-specific path.
      return (await this.getNativeOfflineUrl(key)) !== null;
    }
    // Web: check Shaka offline URI
    const mfid = key.replace('download-', '');
    return !!this.getShakaOfflineUri(Number(mfid));
  }

  /** Get the native directory path for progressive downloads (HLS segments). */
  async getNativeDestDir(key: string): Promise<string | null> {
    if (!this.isNative) return null;
    try {
      const { Filesystem, Directory } = await getFs();
      const dirPath = `fliks-downloads/${key}`;
      await Filesystem.mkdir({ path: dirPath, directory: Directory.Data, recursive: true }).catch(() => {});
      const uri = await Filesystem.getUri({ path: dirPath, directory: Directory.Data });
      return uri.uri.replace('file://', '');
    } catch {
      return null;
    }
  }

  // --- Native (Capacitor Filesystem) ---

  private async ensureDir(): Promise<void> {
    try {
      const { Filesystem, Directory } = await getFs();
      await Filesystem.mkdir({
        path: 'fliks-downloads',
        directory: Directory.Data,
        recursive: true,
      });
    } catch { /* Already exists */ }
  }

  private async hasNative(key: string): Promise<boolean> {
    try {
      const { Filesystem, Directory } = await getFs();
      await Filesystem.stat({
        path: `fliks-downloads/${key}`,
        directory: Directory.Data,
      });
      return true;
    } catch {
      return false;
    }
  }

  private async getNativeHlsUrl(key: string): Promise<string | null> {
    if (!(await this.hasNative(`${key}/index.m3u8`))) return null;
    try {
      const { Filesystem, Directory } = await getFs();
      const result = await Filesystem.getUri({
        path: `fliks-downloads/${key}/index.m3u8`,
        directory: Directory.Data,
      });
      return Capacitor.convertFileSrc(result.uri);
    } catch {
      return null;
    }
  }

  private async deleteNative(key: string): Promise<void> {
    try {
      const { Filesystem, Directory } = await getFs();
      await Filesystem.rmdir({
        path: `fliks-downloads/${key}`,
        directory: Directory.Data,
        recursive: true,
      });
    } catch { /* doesn't exist — fine */ }
  }

}
