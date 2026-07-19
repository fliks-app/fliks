/** `-init_hw_device` args + DRI render node, centralised so the Linux ↔
 *  Windows device-init difference lives in one place. The render node is
 *  admin-selectable (multi-GPU hosts) via {@link setSelectedRenderNode}. */

export const VAAPI_DEVICE_ALIAS = 'va';
export const QSV_DEVICE_ALIAS = 'qs';
export const D3D11VA_DEVICE_ALIAS = 'dx';

/** Admin-selected DRI render node (from the `streaming_gpu_render_node`
 *  setting). Null = "auto" → fall back to the env override, then the default.
 *  Set from the streaming settings on boot and on every playback-info, so a
 *  multi-GPU host can pin transcoding to a specific adapter. */
let selectedRenderNode: string | null = null;

/** Update the admin GPU selection. `'auto'`, empty, or nullish clears it. */
export function setSelectedRenderNode(node: string | null | undefined): void {
  const v = node?.trim();
  selectedRenderNode = v && v.length > 0 && v !== 'auto' ? v : null;
}

/** DRI render node for the VAAPI/Linux-QSV device. Resolution order: the
 *  admin `streaming_gpu_render_node` selection, then the
 *  `FLIKS_VAAPI_RENDER_NODE` env override, then the default. Ignored on
 *  Windows (MFX/D3D11, no node). */
export function vaapiRenderNode(): string {
  if (selectedRenderNode) return selectedRenderNode;
  const override = process.env.FLIKS_VAAPI_RENDER_NODE?.trim();
  return override && override.length > 0 ? override : '/dev/dri/renderD128';
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

/** Windows QSV device derived from an explicit D3D11VA device (`dx`):
 *  `-init_hw_device d3d11va=dx -init_hw_device qsv=qs@dx`. Paired with a
 *  `d3d11va` decode + `hwmap=derive_device=qsv` so the decoded texture and the
 *  `vpp_qsv`/encoder share one D3D11 device. Preferred over the native
 *  `-hwaccel qsv` decode on Windows, whose AV1 decoder fails on real streams.
 *  Windows-only. */
export function qsvViaD3d11DeviceInitArgs(): string[] {
  return [
    '-init_hw_device',
    `d3d11va=${D3D11VA_DEVICE_ALIAS}`,
    '-init_hw_device',
    `qsv=${QSV_DEVICE_ALIAS}@${D3D11VA_DEVICE_ALIAS}`,
  ];
}

/** Whether QSV is backed by a VAAPI device on this host: true on Linux
 *  (`qsv=qs@va`), false on Windows (native D3D11). The QSV→VAAPI crop
 *  fallback and the VAAPI/`tonemap_vaapi` tone-map paths need a VAAPI device,
 *  so when this is false they must stay QSV-native (`vpp_qsv`) or drop to CPU —
 *  there is no VAAPI to route through. (macOS has no QSV, so it never asks.) */
export function hostHasVaapi(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== 'win32';
}

/** OpenCL device + filter selector for the NVENC/CPU standalone tonemap
 *  chain (`hwupload,tonemap_opencl,hwdownload`). Defaults to `ocl` (auto-pick
 *  the first usable platform — the NVIDIA GPU on an NVENC host). Set
 *  `FLIKS_OPENCL_DEVICE` to a `platform.device` selector (e.g. `0.0`) to pin
 *  it when a multi-GPU host auto-picks the wrong vendor. Not the QSV↔OpenCL
 *  bridge, which stays on the Intel iGPU. */
export function openclTonemapInitArgs(): string[] {
  const selector = process.env.FLIKS_OPENCL_DEVICE?.trim();
  const spec =
    selector && selector.length > 0 ? `opencl=ocl:${selector}` : 'opencl=ocl';
  return ['-init_hw_device', spec, '-filter_hw_device', 'ocl'];
}
