import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createEngineClient, type EngineClient } from './engine-client';
import type { components } from './schema';
import type { StreamingSettings } from '../streaming/streaming-settings-cache.service';

export type { EngineClient };
export type Capabilities = components['schemas']['CapabilitiesResponse'];
export type EngineStreamingConfig = components['schemas']['StreamingConfig'];
export type ProbeResult = components['schemas']['ProbeResult'];

export const MIN_ENGINE_PROTOCOL = 1;
export const REQUIRED_FEATURES = ['probe', 'capabilities'];

const HELLO_ATTEMPTS = 20;
const HELLO_RETRY_MS = 500;
/** Detection runs every probe once; a cold GPU host takes minutes. */
const CAPABILITIES_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_RENDER_NODE = '/dev/dri/renderD128';

export function toEngineStreaming(
  ss: StreamingSettings,
): EngineStreamingConfig {
  return {
    segmentDuration: ss.segmentDuration,
    qsvPreset: ss.qsvPreset,
    tonemapAlgo: ss.tonemapAlgo,
    tonemapCurve: ss.tonemapCurve,
    cacheMaxBytes: ss.cacheMaxBytes,
    cacheTtlMs: ss.cacheTtlMs,
    ffmpegSlots: ss.ffmpegSlots,
    autoQualityMode: ss.autoQualityMode,
    autoCropEnabled: ss.autoCropEnabled,
    gpuRenderNode: ss.gpuRenderNode,
    subtitlePrewarm: ss.subtitlePrewarm,
    throttleEnabled: ss.throttleEnabled,
    throttleThresholdSeconds: ss.throttleThresholdSeconds,
  };
}

@Injectable()
export class EngineService implements OnModuleInit {
  private readonly log = new Logger(EngineService.name);
  private client: EngineClient | null = null;
  private ready: Promise<void> | null = null;
  private revision = 0;
  private lastPushed = '';
  protected sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  /** True once the engine answered `hello` with a compatible protocol. */
  get enabled(): boolean {
    return this.client !== null;
  }

  onModuleInit(): Promise<void> {
    return this.whenReady();
  }

  /** Resolves when the boot handshake ended, whatever its outcome: check {@link enabled} after. */
  whenReady(): Promise<void> {
    this.ready ??= this.init();
    return this.ready;
  }

  private async init(): Promise<void> {
    const url = process.env.FLIKS_ENGINE_URL;
    const token = process.env.FLIKS_ENGINE_TOKEN;
    if (!url || !token) {
      this.log.log(
        'FLIKS_ENGINE_URL/FLIKS_ENGINE_TOKEN unset: engine disabled, using the TS paths',
      );
      return;
    }
    await this.connect(createEngineClient(url, token));
  }

  /** Handshake: retries while the engine starts, refuses an incompatible one. */
  async connect(client: EngineClient): Promise<void> {
    for (let attempt = 1; attempt <= HELLO_ATTEMPTS; attempt++) {
      try {
        const { data } = await client.GET('/v1/hello');
        if (data) {
          if (data.protocolVersion < MIN_ENGINE_PROTOCOL) {
            this.log.error(
              `engine protocol ${data.protocolVersion} < ${MIN_ENGINE_PROTOCOL} (engine ${data.engineVersion}): engine disabled`,
            );
            return;
          }
          const missing = REQUIRED_FEATURES.filter(
            (f) => !data.features.includes(f),
          );
          if (missing.length) {
            this.log.error(
              `engine lacks features ${missing.join(', ')}: engine disabled`,
            );
            return;
          }
          const { data: cfg } = await client.GET('/v1/config');
          this.revision = cfg?.revision ?? 0;
          this.client = client;
          this.log.log(
            `engine ${data.engineVersion} hello OK (protocol ${data.protocolVersion}, features ${data.features.join(',')})`,
          );
          return;
        }
      } catch {
        /* engine not listening yet */
      }
      await this.sleep(HELLO_RETRY_MS);
    }
    this.log.error('engine did not answer /v1/hello: engine disabled');
  }

  /** PUT /v1/config with the next revision; a no-op when nothing changed since the last push. */
  async pushStreaming(streaming: EngineStreamingConfig): Promise<void> {
    const key = JSON.stringify(streaming);
    if (!this.client || key === this.lastPushed) return;
    const { response } = await this.client.PUT('/v1/config', {
      body: {
        revision: this.revision + 1,
        hostUrl: null,
        hostToken: null,
        streaming,
      },
    });
    if (!response.ok) throw new Error(`PUT /v1/config -> ${response.status}`);
    this.revision++;
    this.lastPushed = key;
    this.log.log(`config pushed (revision ${this.revision})`);
  }

  /** GET /v1/capabilities, waiting out the 503 + Retry-After of the first detection run. */
  async capabilities(): Promise<Capabilities> {
    const client = this.need();
    const deadline = Date.now() + CAPABILITIES_TIMEOUT_MS;
    for (;;) {
      const { data, response } = await client.GET('/v1/capabilities');
      if (data) return data;
      if (response.status !== 503 || Date.now() > deadline) {
        throw new Error(`GET /v1/capabilities -> ${response.status}`);
      }
      const retry = Number(response.headers.get('retry-after'));
      await this.sleep((retry > 0 ? retry : 1) * 1000);
    }
  }

  /** Capabilities of the run for `gpuRenderNode`: a re-run keeps serving the previous snapshot,
   *  and `defaultGpu` (set whenever there are GPUs) is the only field that tells them apart. */
  async capabilitiesFor(gpuRenderNode: string): Promise<Capabilities> {
    const pin = gpuRenderNode.trim();
    const want = pin && pin !== 'auto' ? pin : DEFAULT_RENDER_NODE;
    const deadline = Date.now() + CAPABILITIES_TIMEOUT_MS;
    for (;;) {
      const caps = await this.capabilities();
      if (!caps.gpus.length || caps.defaultGpu === want) return caps;
      if (Date.now() > deadline) {
        this.log.warn(
          `capabilities still on ${caps.defaultGpu} after pinning ${want}`,
        );
        return caps;
      }
      await this.sleep(1000);
    }
  }

  async probe(
    path: string,
    opts: { crop?: boolean; mkvTags?: boolean; moviehash?: boolean } = {},
  ): Promise<ProbeResult> {
    const { data, response } = await this.need().POST('/v1/probe', {
      body: { media: { mediaFileId: 0, path }, ...opts },
    });
    if (!data) throw new Error(`POST /v1/probe -> ${response.status}`);
    return data;
  }

  private need(): EngineClient {
    if (!this.client) throw new Error('engine disabled');
    return this.client;
  }
}
