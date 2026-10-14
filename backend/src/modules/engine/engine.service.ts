import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { createEngineClient, type EngineClient } from './engine-client';
import type { components } from './schema';
import type { StreamingSettings } from '../streaming/streaming-settings-cache.service';
import { engineLifetime } from '../streaming/lifetime-constants';

export type { EngineClient };
export type Capabilities = components['schemas']['CapabilitiesResponse'];
export type EngineStreamingConfig = components['schemas']['StreamingConfig'];
export type ProbeResult = components['schemas']['ProbeResult'];
export type OpenSessionRequest = components['schemas']['OpenSessionRequest'];
export type OpenSessionResponse = components['schemas']['OpenSessionResponse'];
export type SessionSnapshot = components['schemas']['SessionSnapshot'];
export type EngineEvent = components['schemas']['EngineEvent'];
export type CacheSummary = components['schemas']['CacheSummary'];
export type HeartbeatRequest = components['schemas']['HeartbeatRequest'];
export type SessionAction = components['schemas']['SessionAction'];
export type QualityEstimate = components['schemas']['QualityEstimate'];
type EstimateSizesRequest = components['schemas']['EstimateSizesRequest'];

/** A non-2xx answer of the engine; `status` tells the caller what to map it to. */
export class EngineError extends Error {
  constructor(
    readonly status: number,
    what: string,
  ) {
    super(`${what} -> ${status}`);
  }
}

export const MIN_ENGINE_PROTOCOL = 1;
/** Where the engine reaches the resolver. FLIKS_HOST_URL for a remote engine; the loopback
 *  default is the one acceptable one: the host is local whenever the engine is supervised. */
export function hostUrl(): string {
  return (
    process.env.FLIKS_HOST_URL ||
    `http://127.0.0.1:${Number(process.env.PORT) || 4848}`
  );
}

export const REQUIRED_FEATURES = ['probe', 'capabilities'];
/** The engine runs playback (sessions, data plane, events) only when it announces all three. */
export const RUNTIME_FEATURES = ['sessions', 'serve', 'events'];
const OPEN_TIMEOUT_MS = 15_000;

const HELLO_ATTEMPTS = 20;
const HELLO_RETRY_MS = 500;
const POLL_MS = 10_000;
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
export class EngineService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(EngineService.name);
  private client: EngineClient | null = null;
  private ready: Promise<void> | null = null;
  private candidate: EngineClient | null = null;
  private instanceId = '';
  private features: string[] = [];
  /** Random per boot: the engine presents it to the resolver as its Bearer. */
  readonly hostToken = randomBytes(32).toString('hex');
  private delay = HELLO_RETRY_MS;
  private timer?: NodeJS.Timeout;
  private listeners: (() => void)[] = [];
  private revision = 0;
  private lastPushed = '';
  private reachable = false;
  protected sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  /** True once the engine answered `hello` with a compatible protocol. */
  get enabled(): boolean {
    return this.client !== null;
  }

  /** The engine runs playback; without it playback-info answers 503. */
  get runtime(): boolean {
    return (
      this.client !== null &&
      RUNTIME_FEATURES.every((f) => this.features.includes(f))
    );
  }

  /** `off`: not configured or refused; `down`: configured but the last hello failed. */
  get status(): 'off' | 'up' | 'down' {
    if (!process.env.FLIKS_ENGINE_URL) return 'off';
    if (!this.client) return this.candidate ? 'down' : 'off';
    return this.reachable ? 'up' : 'down';
  }

  /** `hello.features` of the adopted engine, empty without one. */
  get engineFeatures(): readonly string[] {
    return this.client ? this.features : [];
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
      this.log.error(
        'FLIKS_ENGINE_URL/FLIKS_ENGINE_TOKEN unset: playback is unavailable without the engine',
      );
      return;
    }
    await this.connect(createEngineClient(url, token));
  }

  /** Handshake: retries while the engine starts, then keeps going in the background. */
  async connect(client: EngineClient): Promise<void> {
    this.candidate = client;
    for (let attempt = 1; attempt <= HELLO_ATTEMPTS; attempt++) {
      const data = await this.hello();
      if (data) {
        if (await this.adopt(data, false)) this.schedule(POLL_MS);
        return;
      }
      await this.sleep(HELLO_RETRY_MS);
    }
    this.log.error(
      'engine did not answer /v1/hello: no playback until it does, retrying in the background',
    );
    this.schedule(this.backoff());
  }

  onModuleDestroy(): void {
    clearTimeout(this.timer);
  }

  /** Called when the engine (re)appears after boot, so the config and capabilities get loaded again. */
  onConnect(listener: () => void): void {
    this.listeners.push(listener);
  }

  private async hello() {
    try {
      const { data } = await this.candidate!.GET('/v1/hello');
      return data;
    } catch {
      return undefined;
    }
  }

  /** Validates the engine and takes it as the current instance; false when it is refused. */
  private async adopt(
    data: NonNullable<Awaited<ReturnType<EngineService['hello']>>>,
    notify: boolean,
  ): Promise<boolean> {
    const client = this.candidate!;
    const missing = REQUIRED_FEATURES.filter((f) => !data.features.includes(f));
    const refusal =
      data.protocolVersion < MIN_ENGINE_PROTOCOL
        ? `engine protocol ${data.protocolVersion} < ${MIN_ENGINE_PROTOCOL} (engine ${data.engineVersion})`
        : missing.length && `engine lacks features ${missing.join(', ')}`;
    if (refusal) {
      this.log.error(`${refusal}: engine disabled`);
      this.client = null;
      return false;
    }
    const { data: cfg } = await client.GET('/v1/config');
    this.revision = cfg?.revision ?? 0;
    this.lastPushed = '';
    this.instanceId = data.instanceId;
    this.features = data.features;
    this.client = client;
    this.reachable = true;
    this.delay = HELLO_RETRY_MS;
    this.log.log(
      `engine ${data.engineVersion} hello OK (protocol ${data.protocolVersion}, features ${data.features.join(',')})`,
    );
    if (notify) this.listeners.forEach((l) => l());
    return true;
  }

  private backoff(): number {
    this.delay = Math.min(this.delay * 2, POLL_MS);
    return this.delay;
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => void this.tick(), ms);
    this.timer.unref();
  }

  /** Background step: reconnect while down, otherwise detect an engine restart by its instanceId. */
  private async tick(): Promise<void> {
    const data = await this.hello();
    const connected = this.client !== null;
    this.reachable = !!data;
    if (!data) {
      this.schedule(connected ? POLL_MS : this.backoff());
      return;
    }
    if (connected && data.instanceId === this.instanceId) {
      this.schedule(POLL_MS);
      return;
    }
    if (connected)
      this.log.log('engine restarted: reloading config and capabilities');
    try {
      if (await this.adopt(data, true)) this.schedule(POLL_MS);
    } catch {
      this.schedule(POLL_MS);
    }
  }

  /** PUT /v1/config with the next revision; a no-op when nothing changed since the last push. */
  async pushStreaming(streaming: EngineStreamingConfig): Promise<void> {
    const key = JSON.stringify(streaming);
    if (!this.client || key === this.lastPushed) return;
    const { response } = await this.client.PUT('/v1/config', {
      body: {
        revision: this.revision + 1,
        hostUrl: hostUrl(),
        hostToken: this.hostToken,
        streaming,
        lifetime: engineLifetime(),
      },
    });
    if (!response.ok) throw new Error(`PUT /v1/config -> ${response.status}`);
    this.revision++;
    this.lastPushed = key;
    this.log.log(`config pushed (revision ${this.revision})`);
  }

  /** Constant-time check of the `Authorization` header the engine sends to the resolver. */
  isHostAuth(header: string | undefined): boolean {
    const digest = (v: string) => createHash('sha256').update(v).digest();
    return timingSafeEqual(
      digest(header ?? ''),
      digest(`Bearer ${this.hostToken}`),
    );
  }

  /** Kills the owner's engine sessions and purges their resolver cache, best effort: the 60 s TTL bounds a miss. */
  async revokeOwner(ownerId: number): Promise<void> {
    if (!this.client || !this.features.includes('revoke')) return;
    try {
      const { response } = await this.client.POST('/v1/revoke', {
        body: { ownerId: String(ownerId) },
      });
      if (!response.ok) this.log.warn(`POST /v1/revoke -> ${response.status}`);
    } catch (err) {
      this.log.warn(`POST /v1/revoke failed: ${err}`);
    }
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

  /** Download size per quality rung of a probed file. */
  async estimateSizes(
    info: unknown,
    fileSize: number,
  ): Promise<QualityEstimate[]> {
    const { data, response } = await this.need().POST('/v1/estimate-sizes', {
      body: { info: (info ?? {}) as EstimateSizesRequest['info'], fileSize },
    });
    if (!data)
      throw new EngineError(response.status, 'POST /v1/estimate-sizes');
    return data;
  }

  /** Drops the file's jobs, cache entries and subtitle extracts, best effort: a replaced file. */
  async invalidate(mediaFileId: number): Promise<void> {
    if (!this.client) return;
    try {
      const { response } = await this.client.POST('/v1/invalidate', {
        body: { mediaFileId },
      });
      if (!response.ok)
        this.log.warn(`POST /v1/invalidate -> ${response.status}`);
    } catch (err) {
      this.log.warn(`POST /v1/invalidate failed: ${err}`);
    }
  }

  /** POST /v1/sessions, waiting out the 503 + Retry-After of the first detection run. */
  async openSession(body: OpenSessionRequest): Promise<OpenSessionResponse> {
    const client = this.need();
    const deadline = Date.now() + OPEN_TIMEOUT_MS;
    for (;;) {
      const { data, response } = await client.POST('/v1/sessions', { body });
      if (data) return data;
      if (response.status !== 503 || Date.now() > deadline) {
        throw new EngineError(response.status, 'POST /v1/sessions');
      }
      await this.sleep(
        (Number(response.headers.get('retry-after')) || 1) * 1000,
      );
    }
  }

  /** `sessionLost` when the engine no longer knows the sid; throws EngineError 403 for another owner. */
  async heartbeat(
    sid: string,
    body: HeartbeatRequest,
  ): Promise<{ sessionLost: boolean }> {
    const { data, response } = await this.need().POST(
      '/v1/sessions/{sid}/heartbeat',
      {
        path: { sid },
        body,
      },
    );
    if (!data) throw new EngineError(response.status, 'POST heartbeat');
    return data;
  }

  /** Idempotent: an unknown sid is fine. */
  async deleteSession(sid: string, reason?: string): Promise<void> {
    const { response } = await this.need().DELETE('/v1/sessions/{sid}', {
      path: { sid },
      query: { reason },
    });
    if (!response.ok) throw new EngineError(response.status, 'DELETE session');
  }

  /** The HTTP status of the command: 204 done, 404 unknown sid, 409 nothing to pause or stop. */
  async sessionCommand(sid: string, action: SessionAction): Promise<number> {
    const { response } = await this.need().POST('/v1/sessions/{sid}/command', {
      path: { sid },
      body: { action },
    });
    return response.status;
  }

  async listSessions(
    filter: { ownerId?: string; mediaFileId?: number } = {},
  ): Promise<SessionSnapshot[]> {
    const { data, response } = await this.need().GET('/v1/sessions', {
      query: filter,
    });
    if (!data) throw new EngineError(response.status, 'GET /v1/sessions');
    return data;
  }

  async getSession(sid: string): Promise<SessionSnapshot | null> {
    const { data, response } = await this.need().GET('/v1/sessions/{sid}', {
      path: { sid },
    });
    if (response.status === 404) return null;
    if (!data) throw new EngineError(response.status, 'GET session');
    return data;
  }

  async cache(): Promise<CacheSummary> {
    const { data, response } = await this.need().GET('/v1/cache');
    if (!data) throw new EngineError(response.status, 'GET /v1/cache');
    return data;
  }

  /** Removes the matching non-live entries; the count of entries removed. */
  async purgeCache(
    filter: { mediaFileId?: number; ownerId?: string } = {},
  ): Promise<number> {
    const { data, response } = await this.need().DELETE('/v1/cache', {
      query: filter,
    });
    if (!data) throw new EngineError(response.status, 'DELETE /v1/cache');
    return data.removed;
  }

  /** The open SSE response of `GET /v1/events`; the caller reads and aborts it. */
  events(signal: AbortSignal): Promise<Response> {
    return this.need().stream('/v1/events', signal);
  }

  private need(): EngineClient {
    if (!this.client)
      throw new ServiceUnavailableException(
        'The streaming engine is not running',
      );
    return this.client;
  }
}
