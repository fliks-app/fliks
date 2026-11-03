import { Capacitor, registerPlugin } from '@capacitor/core';

interface SaveFilePlugin {
  /** Opens the system "save as" picker; `data` is base64. */
  save(o: { name: string; mimeType: string; data: string }): Promise<{ saved: boolean }>;
}
const SaveFile = registerPlugin<SaveFilePlugin>('SaveFile');

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve((r.result as string).slice((r.result as string).indexOf(',') + 1));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Saves a blob as a file: an anchor download on web and desktop, the native picker in the mobile apps. */
export async function saveFile(blob: Blob, name: string): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    await SaveFile.save({ name, mimeType: blob.type || 'application/octet-stream', data: await base64(blob) });
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Closing the share sheet rejects with an AbortError on the web and "Share canceled" on Android and iOS. */
const isShareDismissal = (e: unknown): boolean =>
  (e as DOMException)?.name === 'AbortError' || (e as Error)?.message === 'Share canceled';

/** Hands server files to the user: direct browser downloads on web and desktop, the OS share sheet in the mobile apps. Each `url` carries its own token. */
export async function deliverFiles(files: { url: string; name: string }[]): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    for (const f of files) {
      const a = document.createElement('a');
      a.href = f.url;
      a.download = f.name;
      a.click();
      await new Promise((r) => setTimeout(r, 300));
    }
    return;
  }
  const [{ Filesystem, Directory }, { Share }] = await Promise.all([import('@capacitor/filesystem'), import('@capacitor/share')]);
  // The receiving app may still be reading when the sheet closes: the previous share is cleared here, not after.
  await Filesystem.rmdir({ path: 'share', directory: Directory.Cache, recursive: true }).catch(() => undefined);
  const dir = 'share';
  try {
    const uris: string[] = [];
    for (const f of files) {
      const path = `${dir}/${f.name}`;
      await Filesystem.downloadFile({ url: f.url, path, directory: Directory.Cache, recursive: true });
      uris.push((await Filesystem.getUri({ path, directory: Directory.Cache })).uri);
    }
    await Share.share({ files: uris });
  } catch (e) {
    if (!isShareDismissal(e)) throw e;
  }
}
