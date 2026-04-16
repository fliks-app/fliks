import { Injectable, inject } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { AuthService } from './auth.service';

const CACHE_NAME = 'offline-media';

/** Lazy-loaded Filesystem reference — avoids crash on web where the plugin isn't available. */
let _fs: typeof import('@capacitor/filesystem') | null = null;
async function getFs() {
  if (!_fs) _fs = await import('@capacitor/filesystem');
  return _fs;
}

@Injectable({ providedIn: 'root' })
export class OfflineStorageService {
  private readonly isNative = Capacitor.isNativePlatform();
  private readonly auth = inject(AuthService);

  async getLocalUrl(key: string): Promise<string | null> {
    if (this.isNative) {
      return this.getNativeHlsUrl(key);
    }
    return this.buildOfflineHlsManifest(key);
  }

  async delete(key: string): Promise<void> {
    if (this.isNative) return this.deleteNative(key);
    return this.deleteSegments(key);
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

  async has(key: string): Promise<boolean> {
    if (this.isNative) {
      return this.hasNative(`${key}/index.m3u8`);
    }
    return this.hasSegments(key);
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

  // --- Web: segment-based progressive storage (Cache API) ---

  /** Store a single segment directly into Cache API (zero RAM). */
  async cacheSegment(key: string, response: Response): Promise<void> {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(key, response);
  }

  /** Store JSON metadata for a completed progressive download. */
  async cacheProgressMeta(
    key: string,
    meta: { segmentCount: number; segmentDuration: number },
  ): Promise<void> {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(
      `${key}/meta`,
      new Response(JSON.stringify(meta), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }

  /**
   * Build a local HLS manifest using `/offline-hls/` URLs. A Service Worker
   * intercepts these requests and serves segments from Cache API — Shaka
   * sees normal HTTP responses. No custom scheme, no blob URLs.
   */
  async buildOfflineHlsManifest(key: string): Promise<string | null> {
    const cache = await caches.open(CACHE_NAME);
    const metaResp = await cache.match(`${key}/meta`);
    if (!metaResp) return null;
    const meta = await metaResp.json();
    const count: number = meta.segmentCount;
    const segDuration: number = meta.segmentDuration ?? 3;
    const totalDuration = count * segDuration;

    if (!(await cache.match(`${key}/init.mp4`))) return null;

    // Ensure Service Worker is registered
    await this.ensureOfflineSw();

    const base = `/offline-hls/${key}`;
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      `#EXT-X-TARGETDURATION:${Math.ceil(segDuration)}`,
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      `#EXT-X-MAP:URI="${base}/init.mp4"`,
    ];
    for (let i = 0; i < count; i++) {
      const segLen = Math.min(segDuration, totalDuration - i * segDuration);
      lines.push(`#EXTINF:${segLen.toFixed(3)},`);
      lines.push(`${base}/seg-${String(i).padStart(4, '0')}.m4s`);
    }
    lines.push('#EXT-X-ENDLIST');

    // Store manifest in cache so the SW can serve it too
    const m3u8 = lines.join('\n');
    await cache.put(
      `${key}/index.m3u8`,
      new Response(m3u8, { headers: { 'Content-Type': 'application/x-mpegURL' } }),
    );
    return `${base}/index.m3u8#hls`;
  }

  private swRegistered = false;
  private async ensureOfflineSw(): Promise<void> {
    if (this.swRegistered || this.isNative || !('serviceWorker' in navigator)) return;
    try {
      await navigator.serviceWorker.register('/offline-sw.js');
      // Wait for the SW to activate so it can intercept fetches
      const reg = await navigator.serviceWorker.ready;
      if (reg.active) this.swRegistered = true;
    } catch (e) {
      console.warn('[offline] SW registration failed:', e);
    }
  }

  /** Delete all cached segments + metadata. Scans cache keys to catch
   *  incomplete downloads (where meta wasn't stored yet). */
  async deleteSegments(key: string): Promise<void> {
    try {
      const cache = await caches.open(CACHE_NAME);
      const keys = await cache.keys();
      for (const req of keys) {
        // Match entries whose URL contains our key prefix
        // Cache API keys are Request objects; url can be relative or absolute
        const url = req.url ?? String(req);
        if (url.includes(key + '/') || url.includes(key + '%2F')) {
          await cache.delete(req);
        }
      }
    } catch { /* ignore */ }
  }

  /** Check if progressive web download is complete (has metadata). */
  async hasSegments(key: string): Promise<boolean> {
    try {
      const cache = await caches.open(CACHE_NAME);
      return !!(await cache.match(`${key}/meta`));
    } catch {
      return false;
    }
  }
}
