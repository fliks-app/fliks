import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  EngineService,
  toEngineStreaming,
  type Capabilities,
} from '../engine/engine.service';
import type { components } from '../engine/schema';
import { setFfmpegSlots } from '../../common/utils/ffmpeg-slots';
import {
  setSelectedRenderNode,
  vaapiRenderNode,
} from '../media-tools/hw-device';
import {
  StreamingSettingsCache,
  type StreamingSettings,
} from './streaming-settings-cache.service';

export type HwAccelType = components['schemas']['HwAccel'];

/** The host's hardware as the engine detected it, for live TV, the dashboard and `info/*`;
 *  also applies the admin GPU pin and job slots the Node-side ffmpeg runs read. */
@Injectable()
export class HostHardwareService implements OnModuleInit {
  private readonly log = new Logger(HostHardwareService.name);
  private caps: Capabilities | null = null;
  private node: string | undefined;

  constructor(
    private readonly settings: StreamingSettingsCache,
    private readonly engine: EngineService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.engine.onConnect(() => void this.load());
    await this.engine.whenReady();
    await this.load();
  }

  /** Boot and engine (re)connect: pin and push first, so the one detection run is on the right node. */
  private async load(): Promise<void> {
    try {
      await this.apply(await this.settings.get(), true);
    } catch (err) {
      this.log.warn(
        `streaming settings not applied: ${(err as Error).message}`,
      );
    }
  }

  /** Applies the admin settings; a GPU re-pin re-runs the engine's detection. */
  async apply(ss: StreamingSettings, redetect = false): Promise<void> {
    setSelectedRenderNode(ss.gpuRenderNode);
    setFfmpegSlots(ss.ffmpegSlots);
    const rePinned = this.node !== undefined && this.node !== ss.gpuRenderNode;
    this.node = ss.gpuRenderNode;
    if (!this.engine.enabled) return;
    await this.engine
      .pushStreaming(toEngineStreaming(ss))
      .catch((err: Error) =>
        this.log.warn(`engine config not pushed: ${err.message}`),
      );
    if (redetect || rePinned) void this.refresh(ss.gpuRenderNode);
  }

  private async refresh(node: string): Promise<void> {
    try {
      this.caps = await this.engine.capabilitiesFor(node);
      this.log.log(
        `Hardware acceleration: ${this.caps.hwAccel} (from the engine)`,
      );
    } catch (err) {
      this.log.warn(
        `engine capabilities unavailable: ${(err as Error).message}`,
      );
    }
  }

  get hwAccel(): HwAccelType {
    return (this.caps?.hwAccel ?? 'none') as HwAccelType;
  }

  get tonemapAlgos(): string[] {
    return this.caps?.tonemapAlgos ?? ['auto'];
  }

  get pauseCapability(): string {
    return this.caps?.pauseCapability ?? 'none';
  }

  get libfdkAac(): boolean {
    return this.caps?.hostCaps.libfdkAac ?? false;
  }

  /** `defaultNode` is what `'auto'` resolves to. */
  gpus(): {
    gpus: { renderNode: string; label: string; kind: string }[];
    defaultNode: string;
  } {
    return {
      gpus: (this.caps?.gpus ?? []).map((g) => ({
        renderNode: g.renderNode,
        label: g.name,
        kind: 'unknown',
      })),
      defaultNode: vaapiRenderNode(),
    };
  }
}
