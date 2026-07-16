/** `-init_hw_device` args + DRI render node, centralised so the Linux ↔
 *  Windows device-init difference lives in one place. */

export const VAAPI_DEVICE_ALIAS = 'va';
export const QSV_DEVICE_ALIAS = 'qs';

/** DRI render node for the VAAPI/Linux-QSV device. Override with
 *  `FLIKS_VAAPI_RENDER_NODE`; ignored on Windows (MFX/D3D11, no node). */
export function vaapiRenderNode(): string {
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
