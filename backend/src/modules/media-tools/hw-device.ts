/** `-init_hw_device` args + DRI render node, centralised so the Linux ↔
 *  Windows device-init difference lives in one place. The render node is
 *  admin-selectable (multi-GPU hosts) via {@link setSelectedRenderNode}. */

export const VAAPI_DEVICE_ALIAS = 'va';
export const QSV_DEVICE_ALIAS = 'qs';

/** Admin-selected DRI render node (from the `streaming_gpu_render_node`
 *  setting). Null = "auto" → the default node.
 *  Set from the streaming settings on boot and on every playback-info. */
let selectedRenderNode: string | null = null;

/** Update the admin GPU selection. `'auto'`, empty, or nullish clears it. */
export function setSelectedRenderNode(node: string | null | undefined): void {
  const v = node?.trim();
  selectedRenderNode = v && v.length > 0 && v !== 'auto' ? v : null;
}

/** DRI render node for the VAAPI/Linux-QSV device: the admin
 *  `streaming_gpu_render_node` selection, or the first node otherwise. Ignored
 *  on Windows (MFX/D3D11, no node). */
export function vaapiRenderNode(): string {
  return selectedRenderNode ?? '/dev/dri/renderD128';
}

/** VAAPI device aliased `va` on the render node. Linux-only. */
export function vaapiDeviceInitArgs(): string[] {
  return ['-init_hw_device', `vaapi=${VAAPI_DEVICE_ALIAS}:${vaapiRenderNode()}`];
}

/** QSV device aliased `qs`: derived from VAAPI on Linux (`qsv=qs@va`),
 *  native MFX/D3D11 on Windows (`qsv=qs`, no render node). */
export function qsvDeviceInitArgs(
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === 'win32') {
    return ['-init_hw_device', `qsv=${QSV_DEVICE_ALIAS}`];
  }
  return [
    ...vaapiDeviceInitArgs(),
    '-init_hw_device',
    `qsv=${QSV_DEVICE_ALIAS}@${VAAPI_DEVICE_ALIAS}`,
  ];
}
