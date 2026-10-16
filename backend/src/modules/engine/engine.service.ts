import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import {
  ENGINE_TOKEN_KEY,
  ENGINE_URL_KEY,
  engineUrlsDiffer,
} from './engine-remote-config';
import { createEngineClient, type EngineClient } from './engine-client';
import type { components } from './schema';

export type { EngineClient };
export type Capabilities = components['schemas']['CapabilitiesResponse'];
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
export type JobRequest = components['schemas']['JobRequest'];
export type JobResult = components['schemas']['JobResult'];
export type JobSnapshot = components['schemas']['JobSnapshot'];
export type JobPriority = components['schemas']['JobPriority'];
export type OpenLiveRequest = components['schemas']['OpenLiveRequest'];
export type OpenLiveResponse = components['schemas']['OpenLiveResponse'];
export type LiveSnapshot = components['schemas']['LiveSnapshot'];
export type LiveTvConfig = components['schemas']['LiveTvConfig'];
export type SourceScan = components['schemas']['SourceScan'];
export type SpriteMeta = components['schemas']['SpriteMeta'];
export type Fingerprint = components['schemas']['Fingerprint'];
export type IntroDetectRequest = components['schemas']['IntroDetectRequest'];
export type IntroDetectResponse = components['schemas']['IntroDetectResponse'];
type JobEnd = Pick<JobSnapshot, 'state' | 'result' | 'error'>;
/** The result variant a request's `kind.type` yields. */
type ResultOf<R extends JobRequest> = Extract<
  JobResult,
  { type: R['kind']['type'] }
>;

interface JobWaiter {
  resolve: (end: JobEnd) => void;
  reject: (err: Error) => void;
  onProgress?: (pct: number) => void;
}

/** A non-2xx answer of the engine; `status` tells the caller what to map it to. */
export class EngineError extends Error {
  constructor(
    readonly status: number,
    what: string,
    /** The `code` of the engine's error body, when it sent one. */
    readonly code?: string,
  ) {
    super(`${what} -> ${status}`);
  }
}

/** A background job that ended `failed` or `cancelled`. */
export class JobError extends Error {
  constructor(
    readonly state: JobSnapshot['state'],
    what: string,
  ) {
    super(`engine job ${state}: ${what}`);
  }
}

export const MIN_ENGINE_PROTOCOL = 1;
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

@Injectable()
export class EngineService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(EngineService.name);
  private client: EngineClient | null = null;
  private ready: Promise<void> | null = null;
  private candidate: EngineClient | null = null;
  private instanceId = '';
  private features: string[] = [];
  private delay = HELLO_RETRY_MS;
  private timer?: NodeJS.Timeout;
  private listeners: (() => void)[] = [];
  private readonly jobWaiters = new Map<string, JobWaiter[]>();
  private reachable = false;
  private storedUrl = '';
  private storedToken = '';
  /** Bumped by reconfigure so an in-flight handshake cannot adopt afterwards. */
  private epoch = 0;
  protected sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  constructor(@Optional() private readonly settings?: SettingsService) {}

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
    if (!this.configuredUrl()) return 'off';
    if (!this.client) return this.candidate ? 'down' : 'off';
    return this.reachable ? 'up' : 'down';
  }

  /** Saved URL and `FLIKS_ENGINE_URL` point at different engines. Video still follows the process URL. */
  get gatewayMismatch(): boolean {
    return engineUrlsDiffer(this.storedUrl, process.env.FLIKS_ENGINE_URL ?? '');
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

  private configuredUrl(): string {
    const stored = this.storedUrl.trim();
    if (stored) return stored;
    return process.env.FLIKS_ENGINE_URL ?? '';
  }

  private effectiveToken(): string {
    const stored = this.storedToken.trim();
    if (stored) return stored;
    return process.env.FLIKS_ENGINE_TOKEN ?? '';
  }

  private async loadRemoteSettings(): Promise<void> {
    if (!this.settings) return;
    this.storedUrl = (await this.settings.get(ENGINE_URL_KEY)) ?? '';
    this.storedToken = (await this.settings.get(ENGINE_TOKEN_KEY)) ?? '';
  }

  private async init(notify = false): Promise<void> {
    const epoch = this.epoch;
    await this.loadRemoteSettings();
    if (epoch !== this.epoch) return;
    const url = this.configuredUrl();
    const token = this.effectiveToken();
    if (!url || !token) {
      this.log.error(
        'FLIKS_ENGINE_URL/FLIKS_ENGINE_TOKEN unset: playback is unavailable without the engine',
      );
      return;
    }
    await this.connect(createEngineClient(url, token), epoch, notify);
  }

  /** Drops the live client and reconnects from stored settings or env. */
  async reconfigure(): Promise<void> {
    this.epoch++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.client = null;
    this.candidate = null;
    this.reachable = false;
    this.ready = this.init(true);
    await this.ready;
  }

  /** Handshake: retries while the engine starts, then keeps going in the background. */
  async connect(
    client: EngineClient,
    epoch = this.epoch,
    notify = false,
  ): Promise<void> {
    if (epoch !== this.epoch) return;
    this.candidate = client;
    for (let attempt = 1; attempt <= HELLO_ATTEMPTS; attempt++) {
      const data = await this.hello();
      if (epoch !== this.epoch) return;
      if (data) {
        if (this.adopt(data, notify, epoch)) this.schedule(POLL_MS);
        return;
      }
      await this.sleep(HELLO_RETRY_MS);
      if (epoch !== this.epoch) return;
    }
    if (epoch !== this.epoch) return;
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
  private adopt(
    data: NonNullable<Awaited<ReturnType<EngineService['hello']>>>,
    notify: boolean,
    epoch = this.epoch,
  ): boolean {
    if (epoch !== this.epoch) return false;
    const client = this.candidate;
    if (!client) return false;
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
    const epoch = this.epoch;
    this.timer = setTimeout(() => void this.tick(epoch), ms);
    this.timer.unref();
  }

  /** Background step: reconnect while down, otherwise detect an engine restart by its instanceId. */
  private async tick(epoch = this.epoch): Promise<void> {
    if (epoch !== this.epoch) return;
    const data = await this.hello();
    if (epoch !== this.epoch) return;
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
    if (this.adopt(data, true, epoch)) this.schedule(POLL_MS);
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

  /** POST /v1/live, waiting out the 503 + Retry-After of the first detection run; a `live_*` error
   *  body surfaces as an {@link EngineError} with its code. */
  async openLive(body: OpenLiveRequest): Promise<OpenLiveResponse> {
    const client = this.need();
    if (!this.features.includes('live'))
      throw new ServiceUnavailableException(
        'The engine has no live TV runtime',
      );
    const deadline = Date.now() + OPEN_TIMEOUT_MS;
    for (;;) {
      const { data, error, response } = await client.POST('/v1/live', { body });
      if (data) return data;
      const code = error?.code;
      if (response.status !== 503 || code || Date.now() > deadline) {
        throw new EngineError(response.status, 'POST /v1/live', code);
      }
      await this.sleep(
        (Number(response.headers.get('retry-after')) || 1) * 1000,
      );
    }
  }

  async listLive(ownerId?: string): Promise<LiveSnapshot[]> {
    const { data, response } = await this.need().GET('/v1/live', {
      query: { ownerId },
    });
    if (!data) throw new EngineError(response.status, 'GET /v1/live');
    return data;
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

  async introDetect(body: IntroDetectRequest): Promise<IntroDetectResponse> {
    const { data, response } = await this.need().POST('/v1/intro-detect', {
      body,
    });
    if (!data) throw new EngineError(response.status, 'POST /v1/intro-detect');
    return data;
  }

  /** The job's id; an identical request still queued or running answers the same one. */
  async submitJob(req: JobRequest): Promise<string> {
    const { data, response } = await this.need().POST('/v1/jobs', {
      body: req,
    });
    if (!data) throw new EngineError(response.status, 'POST /v1/jobs');
    return data.jobId;
  }

  /** Idempotent: an ended or unknown job is fine. */
  async cancelJob(jobId: string): Promise<void> {
    const { response } = await this.need().DELETE('/v1/jobs/{id}', {
      path: { id: jobId },
    });
    if (!response.ok && response.status !== 404)
      throw new EngineError(response.status, 'DELETE job');
  }

  async getJob(jobId: string): Promise<JobSnapshot | null> {
    const { data, response } = await this.need().GET('/v1/jobs/{id}', {
      path: { id: jobId },
    });
    if (response.status === 404) return null;
    if (!data) throw new EngineError(response.status, 'GET job');
    return data;
  }

  /** Submits and resolves with the result on `BgJobDone`; rejects with {@link JobError} when the
   *  job fails or is cancelled. Survives an events reconnect: {@link resyncJobs} re-checks it. */
  async runJob<R extends JobRequest>(
    req: R,
    onProgress?: (pct: number) => void,
  ): Promise<ResultOf<R>> {
    const jobId = await this.submitJob(req);
    const ended = new Promise<JobEnd>((resolve, reject) => {
      const list = this.jobWaiters.get(jobId) ?? [];
      list.push({ resolve, reject, onProgress });
      this.jobWaiters.set(jobId, list);
    });
    // It may have ended between the POST and the registration above.
    void this.checkJob(jobId);
    const { state, result, error } = await ended;
    if (state !== 'done' || !result)
      throw new JobError(state, error ?? req.kind.type);
    return result as ResultOf<R>;
  }

  /** Fed by the events follower. */
  jobProgress(jobId: string, pct: number): void {
    this.jobWaiters.get(jobId)?.forEach((w) => w.onProgress?.(pct));
  }

  jobEnded(jobId: string, end: JobEnd): void {
    const waiters = this.jobWaiters.get(jobId);
    this.jobWaiters.delete(jobId);
    waiters?.forEach((w) => w.resolve(end));
  }

  /** After an events (re)connect: a `BgJobDone` may have been missed while disconnected. */
  async resyncJobs(): Promise<void> {
    await Promise.all(
      [...this.jobWaiters.keys()].map((id) => this.checkJob(id)),
    );
  }

  private async checkJob(jobId: string): Promise<void> {
    try {
      const snap = await this.getJob(jobId);
      if (!snap) {
        const lost = this.jobWaiters.get(jobId);
        this.jobWaiters.delete(jobId);
        lost?.forEach((w) => w.reject(new Error(`engine lost job ${jobId}`)));
      } else if (['done', 'failed', 'cancelled'].includes(snap.state)) {
        this.jobEnded(jobId, snap);
      }
    } catch {
      // The next resync retries.
    }
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
