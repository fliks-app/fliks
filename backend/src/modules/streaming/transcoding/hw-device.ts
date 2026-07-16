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
