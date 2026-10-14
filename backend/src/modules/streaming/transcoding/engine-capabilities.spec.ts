import { readFileSync } from 'fs';
import { join } from 'path';
import { applyEngineCapabilities } from './engine-capabilities';
import { ALL_DESCRIPTORS } from './codec/encoders';
import { ALL_DECODERS } from './codec/decoders';
import {
  isEncoderEnabled,
  vaapiWritesHdrMetadata,
} from './codec/encoder-probe';
import { isDecoderEnabled } from './codec/decoder-probe';
import { isVppQsvTonemapEnabled } from './codec/vpp-qsv-probe';
import {
  isTonemapOpenclEnabled,
  isTonemapOpenclEnabledWithCrop,
  isTonemapOpenclHdr10Enabled,
} from './codec/tonemap-opencl-probe';
import {
  isOpenclTonemapEnabled,
  isOpenclTonemapHdr10Enabled,
} from './codec/opencl-tonemap-probe';
import {
  isCudaTonemapEnabled,
  isCudaTonemapHdr10Enabled,
} from './codec/cuda-tonemap-probe';
import {
  isQsvOpenclTonemapEnabled,
  isQsvOpenclTonemapHdr10Enabled,
} from './codec/qsv-opencl-probe';
import { isVulkanTonemapEnabled } from './codec/vulkan-tonemap-probe';
import { isAmfOpenclEnabled } from './codec/amf-opencl-probe';
import { isLibfdkAacEnabled } from './audio-encoder-probe';
import { getPauseCapability } from './ffmpeg-pause';
import { TranscodingService } from './transcoding.service';
import type { Capabilities } from '../../engine/engine.service';

interface Scenario {
  name: string;
  capabilities: Capabilities;
}

// Recorded hosts from the engine's fixtures/hw: `expected` is what the TS boot probes ended in.
const scenarios: Scenario[] = JSON.parse(
  readFileSync(join(__dirname, 'engine-capabilities.fixtures.json'), 'utf8'),
);

describe('applyEngineCapabilities', () => {
  it.each(scenarios)(
    'loads $name into the exact state the TS probes produce',
    ({ capabilities: caps }) => {
      const { hwAccel, gpus } = applyEngineCapabilities(caps);
      const host = caps.hostCaps;
      const on = (n: string) => (host.probes ?? []).includes(n);

      expect(hwAccel).toBe(host.hwAccel);
      expect(getPauseCapability()).toBe(caps.pauseCapability);
      for (const d of ALL_DESCRIPTORS) {
        expect(isEncoderEnabled(d.id)).toBe(
          !(host.disabledEncoders ?? []).includes(d.id),
        );
      }
      for (const d of ALL_DECODERS) {
        expect(isDecoderEnabled(d.id)).toBe(
          !(host.disabledDecoders ?? []).includes(d.id),
        );
      }
      expect({
        tonemapOpencl: isTonemapOpenclEnabled(),
        tonemapOpenclCrop: isTonemapOpenclEnabledWithCrop(),
        tonemapOpenclHdr10: isTonemapOpenclHdr10Enabled(),
        qsvOpencl: isQsvOpenclTonemapEnabled(),
        qsvOpenclHdr10: isQsvOpenclTonemapHdr10Enabled(),
        vppQsv: isVppQsvTonemapEnabled(),
        vulkan: isVulkanTonemapEnabled(),
        cuda: isCudaTonemapEnabled(),
        cudaHdr10: isCudaTonemapHdr10Enabled(),
        opencl: isOpenclTonemapEnabled(),
        openclHdr10: isOpenclTonemapHdr10Enabled(),
        amfOpencl: isAmfOpenclEnabled(),
      }).toEqual({
        tonemapOpencl: on('tonemapOpencl'),
        tonemapOpenclCrop: on('tonemapOpenclCrop'),
        tonemapOpenclHdr10: on('tonemapOpenclHdr10'),
        qsvOpencl: on('qsvOpencl'),
        qsvOpenclHdr10: on('qsvOpenclHdr10'),
        vppQsv: on('vppQsv'),
        vulkan: on('vulkan'),
        cuda: on('cuda'),
        cudaHdr10: on('cudaHdr10'),
        opencl: on('opencl'),
        openclHdr10: on('openclHdr10'),
        amfOpencl: on('amfOpencl'),
      });
      expect(isLibfdkAacEnabled()).toBe(host.libfdkAac);
      expect(vaapiWritesHdrMetadata()).toBe(host.vaapiWritesHdrMetadata);
      expect(gpus.map((g) => [g.renderNode, g.label])).toEqual(
        caps.gpus.map((g) => [g.renderNode, g.name]),
      );
    },
  );

  it.each(scenarios)(
    'derives the tone-map list of $name from the loaded state',
    ({ capabilities: caps }) => {
      const { hwAccel } = applyEngineCapabilities(caps);
      const svc = new (TranscodingService as any)(
        {},
        {},
        {},
        {},
      ) as TranscodingService;
      (svc as any).detectedHwAccel = hwAccel;
      expect(svc.getAvailableTonemapAlgos()).toEqual(caps.tonemapAlgos);
    },
  );
});
