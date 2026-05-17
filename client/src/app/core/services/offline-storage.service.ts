import { Injectable, inject } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { AuthService } from './auth.service';

const CACHE_NAME = 'offline-media';

/** Map mediaFileId → Shaka offline:xxx URI. Persisted in localStorage. */
const SHAKA_OFFLINE_KEY = 'fliks.shakaOfflineUris';

/** Lazy-loaded Filesystem reference — avoids crash on web where the plugin isn't available. */
let _fs: typeof import('@capacitor/filesystem') | null = null;
async function getFs() {
  if (!_fs) _fs = await import('@capacitor/filesystem');
  return _fs;
}

/** Lazy-loaded Shaka Player. Eager-importing it pulls ~750 KB into the
 *  initial bundle even though the offline-download path is only reached
 *  from the downloads page (and never on native, where ExoPlayer /
 *  AVPlayer take over). Loaded on first call to `shakaDownload` /
 *  `shakaRemove`. */
let _shaka: typeof import('shaka-player').default | null = null;
async function getShaka() {
  if (!_shaka) _shaka = (await import('shaka-player')).default;
  return _shaka;
}

@Injectable({ providedIn: 'root' })
export class OfflineStorageService {
  private readonly isNative = Capacitor.isNativePlatform();
  private readonly auth = inject(AuthService);

  async getLocalUrl(key: string): Promise<string | null> {
    if (this.isNative) {
      // ExoPlayer stores content in SimpleCache, not filesystem.
      // Return the stored HLS URL — native player uses CacheDataSource to
      // read from cache. The URL is stored in the DownloadTask.
      return this.getNativeOfflineUrl(key);
    }
    // Web: check Shaka offline URI (stored in localStorage)
    const mfid = key.replace('download-', '');
    const offlineUri = this.getShakaOfflineUri(Number(mfid));
    return offlineUri ?? null;
  }

  /** Look up the stored HLS URL for a native download from localStorage. */
  private getNativeOfflineUrl(key: string): string | null {
    try {
      const mfid = Number(key.replace('download-', ''));
      const raw = localStorage.getItem('fliks.downloads.cache');
      const tasks: any[] = raw ? JSON.parse(raw) : [];
      const task = tasks.find((t: any) => t.mediaFileId === mfid && t.status === 'ready');
      return task?.hlsUrl ?? null;
    } catch {
      return null;
    }
  }

  // --- Shaka offline storage (web only) ---

  /** Get stored Shaka offline URI for a media file, or null. */
  getShakaOfflineUri(mediaFileId: number): string | null {
    try {
      const map = JSON.parse(localStorage.getItem(SHAKA_OFFLINE_KEY) ?? '{}');
      return map[String(mediaFileId)] ?? null;
    } catch {
      return null;
    }
  }

  private setShakaOfflineUri(mediaFileId: number, uri: string): void {
    try {
      const map = JSON.parse(localStorage.getItem(SHAKA_OFFLINE_KEY) ?? '{}');
      map[String(mediaFileId)] = uri;
      localStorage.setItem(SHAKA_OFFLINE_KEY, JSON.stringify(map));
    } catch { /* ignore */ }
  }

  private removeShakaOfflineUri(mediaFileId: number): void {
    try {
      const map = JSON.parse(localStorage.getItem(SHAKA_OFFLINE_KEY) ?? '{}');
      delete map[String(mediaFileId)];
      localStorage.setItem(SHAKA_OFFLINE_KEY, JSON.stringify(map));
    } catch { /* ignore */ }
  }

  /**
   * Use Shaka's built-in offline storage to download an HLS stream into
   * IndexedDB. Returns the `offline:` URI for playback, or null on failure.
   */
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
        // Default Shaka stores a single audio track. Keep every audio
        // rendition + the chosen video variant so offline playback exposes
        // all languages in the track picker.
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
      console.log('[Shaka offline] store result:', stored);
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

  async delete(key: string): Promise<void> {
    if (this.isNative) return this.deleteNative(key);
    // Web: remove Shaka offline content
    const mfid = Number(key.replace('download-', ''));
    await this.shakaRemove(mfid);
  }

  /** Download a small text file (VTT subtitle) and store locally. */
  async downloadSmallFile(url: string, key: string): Promise<void> {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.auth.accessToken}` },
    });
    if (!response.ok) return;
    const text = await response.text();

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
  }

  /** Get small file content as text (for VTT). */
  async getSmallFileUrl(key: string): Promise<string | null> {
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

  /** Get native file URI for a small file (for ExoPlayer — not a blob URL). */
  async getSmallFileNativeUri(key: string): Promise<string | null> {
    if (!this.isNative) return this.getSmallFileUrl(key);
    try {
      const { Filesystem, Directory } = await getFs();
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
    if (this.isNative) {
      // ExoPlayer stores in SimpleCache, not filesystem — check localStorage.
      return this.getNativeOfflineUrl(key) !== null;
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
