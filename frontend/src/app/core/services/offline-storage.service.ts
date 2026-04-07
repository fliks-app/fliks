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

  async download(
    url: string,
    key: string,
    onProgress?: (percent: number) => void,
  ): Promise<string> {
    if (this.isNative) {
      return this.downloadNative(url, key, onProgress);
    }
    return this.downloadWeb(url, key, onProgress);
  }

  async getLocalUrl(key: string): Promise<string | null> {
    if (this.isNative) return this.getNativeUrl(key);
    return this.getWebUrl(key);
  }

  async delete(key: string): Promise<void> {
    if (this.isNative) return this.deleteNative(key);
    return this.deleteWeb(key);
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
        directory: Directory.Documents,
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
          directory: Directory.Documents,
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
    if (this.isNative) return this.hasNative(key);
    return this.hasWeb(key);
  }

  // --- Native (Capacitor Filesystem) ---

  private filePath(key: string): string {
    return `fliks-downloads/${key}.mp4`;
  }

  private async ensureDir(): Promise<void> {
    try {
      const { Filesystem, Directory } = await getFs();
      await Filesystem.mkdir({
        path: 'fliks-downloads',
        directory: Directory.Documents,
        recursive: true,
      });
    } catch {
      // Already exists
    }
  }

  private async downloadNative(
    url: string,
    key: string,
    onProgress?: (percent: number) => void,
  ): Promise<string> {
    const { Filesystem, Directory } = await getFs();
    await this.ensureDir();

    // Get expected size via HEAD request
    let expectedSize = 0;
    if (onProgress) {
      try {
        const head = await fetch(url, {
          method: 'HEAD',
          headers: { Authorization: `Bearer ${this.auth.accessToken}` },
        });
        expectedSize = Number(head.headers.get('content-length') ?? 0);
      } catch {
        // ignore — progress won't work
      }
    }

    // Poll file size for progress during download
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    if (onProgress && expectedSize > 0) {
      pollTimer = setInterval(async () => {
        try {
          const stat = await Filesystem.stat({
            path: this.filePath(key),
            directory: Directory.Documents,
          });
          const pct = Math.min(99, Math.round((stat.size / expectedSize) * 100));
          onProgress(pct);
        } catch {
          // File not created yet
        }
      }, 1000);
    }

    try {
      const result = await Filesystem.downloadFile({
        url,
        path: this.filePath(key),
        directory: Directory.Documents,
        headers: { Authorization: `Bearer ${this.auth.accessToken}` },
      });

      onProgress?.(100);

      if (result.path) {
        return Capacitor.convertFileSrc(result.path);
      }

      const uri = await Filesystem.getUri({
        path: this.filePath(key),
        directory: Directory.Documents,
      });
      return Capacitor.convertFileSrc(uri.uri);
    } finally {
      if (pollTimer) clearInterval(pollTimer);
    }
  }

  private async hasNative(key: string): Promise<boolean> {
    try {
      const { Filesystem, Directory } = await getFs();
      await Filesystem.stat({
        path: this.filePath(key),
        directory: Directory.Documents,
      });
      return true;
    } catch {
      return false;
    }
  }

  private async getNativeUrl(key: string): Promise<string | null> {
    if (!(await this.hasNative(key))) return null;
    try {
      const { Filesystem, Directory } = await getFs();
      const result = await Filesystem.getUri({
        path: this.filePath(key),
        directory: Directory.Documents,
      });
      return Capacitor.convertFileSrc(result.uri);
    } catch {
      return null;
    }
  }

  private async deleteNative(key: string): Promise<void> {
    try {
      const { Filesystem, Directory } = await getFs();
      await Filesystem.deleteFile({
        path: this.filePath(key),
        directory: Directory.Documents,
      });
    } catch {
      // File doesn't exist — fine
    }
  }

  // --- Web (Cache API) ---

  private async downloadWeb(
    url: string,
    key: string,
    onProgress?: (percent: number) => void,
  ): Promise<string> {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.auth.accessToken}` },
    });
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);

    const contentLength = Number(response.headers.get('content-length') ?? 0);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');
    const chunks: BlobPart[] = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (contentLength > 0 && onProgress) {
        onProgress(Math.round((received / contentLength) * 100));
      }
    }

    const blob = new Blob(chunks, { type: 'video/mp4' });
    const cache = await caches.open(CACHE_NAME);
    await cache.put(key, new Response(blob));
    return URL.createObjectURL(blob);
  }

  private async hasWeb(key: string): Promise<boolean> {
    try {
      const cache = await caches.open(CACHE_NAME);
      const match = await cache.match(key);
      return match !== undefined;
    } catch {
      return false;
    }
  }

  private async getWebUrl(key: string): Promise<string | null> {
    try {
      const cache = await caches.open(CACHE_NAME);
      const response = await cache.match(key);
      if (!response) return null;
      const blob = await response.blob();
      return URL.createObjectURL(blob);
    } catch {
      return null;
    }
  }

  private async deleteWeb(key: string): Promise<void> {
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.delete(key);
    } catch {
      // ignore
    }
  }
}
