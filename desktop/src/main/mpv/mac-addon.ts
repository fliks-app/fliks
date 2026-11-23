// The macOS libmpv addon (`fliks_player_mac`): an in-process libmpv drawing into a CAMetalLayer under the page.

import { app } from 'electron';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { NowPlayingAddon } from '../now-playing';
import type { LibmpvAddon } from './libmpv-addon-player';

export type MacAddon = LibmpvAddon & NowPlayingAddon & {
  notifyAuthorization(): Promise<string>;
  start(o: { wid: string; scale?: number }): void;
  probeLists(): { 'decoder-list'?: string; 'demuxer-lavf-list'?: string };
  useLiveFullscreen(wid: string): void;
};

/** Resolve + require the native addon (singleton across the process). The .node
 *  addon and the dlopen'd libmpv are asarUnpack'd, so in a packaged app they
 *  live under app.asar.unpacked. */
let macAddon: MacAddon | null = null;
export function loadMacAddon(): MacAddon {
  if (macAddon) return macAddon;
  const base = app.isPackaged
    ? app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked')
    : app.getAppPath();
  // A packaged build ignores a preset path: the addon dlopens whatever it names.
  if (app.isPackaged || !process.env.FLIKS_MPV_PATH) {
    // The Mac App Store build ships libmpv in Contents/Frameworks (electron-builder.yml `mas.extraFiles`).
    process.env.FLIKS_MPV_PATH = process.mas
      ? path.join(process.resourcesPath, '..', 'Frameworks', 'libmpv.dylib')
      : path.join(base, 'native', 'vendor', 'libmpv.dylib');
  }
  macAddon = createRequire(__filename)(
    path.join(base, 'native', 'build', 'Release', 'fliks_player_mac.node'),
  ) as MacAddon;
  return macAddon;
}
