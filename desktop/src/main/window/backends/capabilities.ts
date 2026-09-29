import { resolveWindowsVo } from './gpu-next-probe';
import { resolveBundledMpv } from '../player-session';
import type { DesktopPlayerCapabilities } from '../../../shared/contract';

/** Only Windows can fall back off gpu-next to plain gpu (old driver / low D3D11
 *  feature level); every other backend never reshapes a Dolby Vision RPU. */
export async function getPlayerCapabilities(): Promise<DesktopPlayerCapabilities> {
  if (process.platform !== 'win32') return { canReshapeDolbyVision: false };
  const vo = await resolveWindowsVo(resolveBundledMpv() ?? 'mpv');
  return { canReshapeDolbyVision: vo === 'gpu-next' };
}
