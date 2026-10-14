import type { Capabilities } from '../../engine/engine.service';
import { setPauseCapability, type PauseCapability } from './ffmpeg-pause';
import { ALL_DESCRIPTORS } from './codec/encoders';
import { ALL_DECODERS } from './codec/decoders';
import {
  loadEncoderProbeResults,
  setVaapiWritesHdrMetadata,
} from './codec/encoder-probe';
import { loadDecoderProbeResults } from './codec/decoder-probe';
import { setVppQsvTonemapEnabled } from './codec/vpp-qsv-probe';
import { setTonemapOpenclEnabled } from './codec/tonemap-opencl-probe';
import {
  setOpenclTonemapEnabled,
  setOpenclTonemapHdr10Enabled,
} from './codec/opencl-tonemap-probe';
import {
  setCudaTonemapEnabled,
  setCudaTonemapHdr10Enabled,
} from './codec/cuda-tonemap-probe';
import {
  setQsvOpenclTonemapEnabled,
  setQsvOpenclTonemapHdr10Enabled,
} from './codec/qsv-opencl-probe';
import { setVulkanTonemapEnabled } from './codec/vulkan-tonemap-probe';
import { setAmfOpenclEnabled } from './codec/amf-opencl-probe';
import { setLibfdkAacEnabled } from './audio-encoder-probe';
import type { GpuInfo } from './gpu-registry';
import type { HwAccelType } from './types';

/** Loads the engine's detection into the state the TS builders read, in place of the boot probes. */
export function applyEngineCapabilities(caps: Capabilities): {
  hwAccel: HwAccelType;
  gpus: GpuInfo[];
} {
  loadEncoderProbeResults(
    ALL_DESCRIPTORS.map((d) => d.id),
    new Set(caps.encoders),
  );
  loadDecoderProbeResults(
    ALL_DECODERS.map((d) => d.id),
    new Set(caps.decoders),
  );
  const on = (name: string) => caps.hostCaps.probes.includes(name);
  setTonemapOpenclEnabled({
    basic: on('tonemapOpencl'),
    crop: on('tonemapOpenclCrop'),
    hdr10: on('tonemapOpenclHdr10'),
  });
  setVppQsvTonemapEnabled(on('vppQsv'));
  setQsvOpenclTonemapEnabled(on('qsvOpencl'));
  setQsvOpenclTonemapHdr10Enabled(on('qsvOpenclHdr10'));
  setOpenclTonemapEnabled(on('opencl'));
  setOpenclTonemapHdr10Enabled(on('openclHdr10'));
  setCudaTonemapEnabled(on('cuda'));
  setCudaTonemapHdr10Enabled(on('cudaHdr10'));
  setVulkanTonemapEnabled(on('vulkan'));
  setAmfOpenclEnabled(on('amfOpencl'));
  setLibfdkAacEnabled(caps.hostCaps.libfdkAac);
  setVaapiWritesHdrMetadata(caps.hostCaps.vaapiWritesHdrMetadata);
  setPauseCapability(caps.pauseCapability as PauseCapability);
  return {
    hwAccel: caps.hwAccel as HwAccelType,
    gpus: caps.gpus.map((g) => ({
      renderNode: g.renderNode,
      vendor: '',
      vendorId: '',
      deviceId: '',
      kind: 'unknown',
      label: g.name,
    })),
  };
}
