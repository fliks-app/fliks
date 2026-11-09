import { resolveWindowsVo } from './gpu-next-probe';
import { resolveBundledMpv } from '../player-session';
import { MpvPlayer } from '../../mpv/mpv-player';
import { parseMpvLists, type MpvLists } from '../../mpv/mpv-lists';
import type { DesktopPlayerCapabilities } from '../../../shared/contract';

/** The libmpv addon that can list decoders and demuxers before any playback exists. */
export interface ListsProbe {
  probeLists(): { 'decoder-list'?: string; 'demuxer-lavf-list'?: string };
}

let linuxAddon: ListsProbe | null = null;

/** Linux has no mpv binary, only the compositor addon's libmpv. */
export function probeListsWith(addon: ListsProbe): void {
  linuxAddon = addon;
}

/** Windows runs an mpv subprocess: a throwaway headless one answers over IPC. */
async function listsFromBinary(mpvPath: string): Promise<MpvLists> {
  const player = new MpvPlayer({ baseArgs: ['--vo=null', '--ao=null'], mpvPath });
  try {
    await player.start();
    const [decoders, demuxers] = await Promise.all([
      player.getProperty('decoder-list'),
      player.getProperty('demuxer-lavf-list'),
    ]);
    return parseMpvLists(decoders, demuxers);
  } finally {
    await player.destroy().catch(() => {});
  }
}

async function mpvLists(): Promise<MpvLists | undefined> {
  try {
    if (process.platform === 'win32') return await listsFromBinary(resolveBundledMpv() ?? 'mpv');
    const addon =
      process.platform === 'darwin'
        ? (await import('../../mpv/mac-mpv-player')).loadMacAddon()
        : linuxAddon;
    const raw = addon?.probeLists();
    const lists = raw && parseMpvLists(raw['decoder-list'], raw['demuxer-lavf-list']);
    return lists?.decoders.length ? lists : undefined;
  } catch (e) {
    console.warn('[capabilities] mpv decoder list unavailable', e);
    return undefined;
  }
}

/** Only Windows can fall back off gpu-next to plain gpu (old driver / low D3D11
 *  feature level); every other backend never reshapes a Dolby Vision RPU. */
export async function getPlayerCapabilities(): Promise<DesktopPlayerCapabilities> {
  const lists = await mpvLists();
  if (process.platform !== 'win32') return { canReshapeDolbyVision: false, ...lists };
  const vo = await resolveWindowsVo(resolveBundledMpv() ?? 'mpv');
  return { canReshapeDolbyVision: vo === 'gpu-next', ...lists };
}
