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
