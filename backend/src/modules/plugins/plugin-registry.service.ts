import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as net from 'net';
import * as semver from 'semver';
import { pathToRegexp, type Keys } from 'path-to-regexp';
import { CronExpressionParser } from 'cron-parser';
import { PluginPackage } from './entities/plugin-package.entity';
import { PluginRegistration } from './entities/plugin-registration.entity';
import { PluginProcessService } from './plugin-process.service';
import { PluginJobsService } from './plugin-jobs.service';
import { CURRENT_FLIKS_VERSION } from './plugin-version';
import type { SupervisorState } from './supervisor/plugin-supervisor';
import { arePluginsDisabled, FLIKS_PLUGINS_DISABLED_ENV } from '../../common/constants/plugin-flags';
import {
  PLUGIN_API_VERSION,
  PLUGIN_WEBHOOK_EVENT_NAMES,
  buildIndexerImplementationId,
  INDEXER_ID_SEPARATOR,
  type PluginKind,
  type PluginManifest,
  type ProcessPluginManifest,
  type IndexerDescriptor,
  type PluginWebhookEventName,
  type PluginRoute,
  type PluginJob,
} from '../../common/plugin-contract';
import { OFFICIAL_KEYS, resolveTrust, readArchiveEntries, type TrustOutcome } from './archive';
import { isInternalAddress } from './internal-address';
import type { DomainEvent } from '../scheduler/events.service';
import { PluginRouteTable, type ResolvedPluginRoute } from './proxy/plugin-route-table';
import { parseDeclaredPolicy } from './proxy/policy-vocabulary';
import { parseObjectGuard } from './proxy/plugin-object-guards.service';
import { PLUGIN_PERMISSION_NAME_PATTERN, pluginPermissionSubject } from '../../common/constants/plugin-permissions';
import { CORE_SCHEDULER_JOB_NAMES } from '../../common/constants/core-scheduler-jobs';

const WEBHOOK_EVENT_NAMES: ReadonlySet<string> = new Set(PLUGIN_WEBHOOK_EVENT_NAMES);

/**
 * Fails to typecheck if the contract's webhook catalog and `DomainEvent`'s ever
 * drift apart. `plugin-contract/` cannot import `DomainEvent` (island rule), so
 * this file — which may import both — is where the two are asserted to agree.
 */
type AssertSameStringUnion<A extends string, B extends string> = [A] extends [B]
  ? [B] extends [A]
    ? unknown
    : never
  : never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _webhookCatalogMatchesDomainEvents: AssertSameStringUnion<PluginWebhookEventName, DomainEvent['type']> = true;

export { CURRENT_FLIKS_VERSION };

/** The only `driverApi` core knows how to run a search through today. */
const SUPPORTED_INDEXER_DRIVER_APIS: ReadonlySet<string> = new Set(['torznab']);

/** A manifest route's `method` must be one of these, compared case-insensitively. */
const KNOWN_HTTP_METHODS: ReadonlySet<string> = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/** Shared so a plugin with nothing declared doesn't cost an allocation per lookup. */
const EMPTY_SUBJECT_SET: ReadonlySet<string> = new Set();

const CORE_JOB_NAME_SET: ReadonlySet<string> = new Set(CORE_SCHEDULER_JOB_NAMES);

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export interface RegisteredPlugin {
  pluginId: string;
  version: string;
  kind: PluginKind;
  manifest: PluginManifest;
  signature: TrustOutcome;
  verifiedByKeyId: string | null;
  /** Same buffer as the `plugin_packages` row — the logo route re-extracts from
   *  this on each request rather than the registry caching decoded image bytes. */
  archive: Buffer;
}

export type PluginRegistrationFailureReason =
  | 'untrusted'
  | 'incompatible-api'
  | 'incompatible-fliks'
  | 'unsupported-indexer-driver'
  | 'invalid-indexer-key'
  | 'invalid-indexer-endpoint'
  | 'invalid-webhook-event'
  | 'invalid-webhook-url'
  | 'insecure-webhook-scheme'
  | 'internal-webhook-host'
  | 'invalid-route-method'
  | 'invalid-route-path'
  | 'invalid-route-policy'
  | 'invalid-route-object-guard'
  | 'duplicate-route'
  | 'invalid-permission'
  | 'invalid-job-name'
  | 'invalid-job-cron'
  | 'invalid-job-triggerable'
  | 'invalid-job-label'
  | 'job-name-conflict'
  | 'disabled'
  | 'tampered'
  | 'db-provision-failed'
  | 'spawn-failed';

/**
 * Failures where the plugin is installed and its manifest is sound — only its process
 * isn't up. Its declared routes stay resolvable so they answer 503 rather than 403,
 * which is the difference between "unavailable" and "you may not".
 */
const INSTALLED_BUT_NOT_RUNNING: ReadonlySet<PluginRegistrationFailureReason> = new Set([
  'disabled',
  'tampered',
  'db-provision-failed',
  'spawn-failed',
]);

export interface PluginRegistrationSuccess {
  ok: true;
  pluginId: string;
}
export interface PluginRegistrationFailure {
  ok: false;
  pluginId: string;
  reason: PluginRegistrationFailureReason;
  detail: string;
}
export type PluginRegistrationResult = PluginRegistrationSuccess | PluginRegistrationFailure;

/**
 * In-memory installed-plugin set — the only thing the rest of core asks about
 * plugins. Populated at boot (L0-L4 of `plans/plugin-system.plan.md`'s load
 * table) and by `register()`, the hot-reload entry point the installer calls
 * for both tiers (P4a). L1 (`state.json` quarantine) still has no home; L3
 * (re-hashing `plugin.js` from the loaded fd) is `PluginProcessService`'s.
 */
@Injectable()
export class PluginRegistryService implements OnModuleInit {
  private readonly logger = new Logger(PluginRegistryService.name);
  private readonly registry = new Map<string, RegisteredPlugin>();
  /** Keyed by the namespaced id (`buildIndexerImplementationId`), rebuilt per plugin on every `register()`. */
  private readonly indexerDescriptors = new Map<string, { pluginId: string; descriptor: IndexerDescriptor }>();
  /** Keyed by plugin id; entries are already validated (URL, scheme, event name) — the
   *  dispatcher trusts this without re-checking any of that. */
  private readonly webhookDeclarations = new Map<string, { event: PluginWebhookEventName; webhook: string }[]>();
  /** Keyed by plugin id; compiled once per `register()` from already-validated routes. */
  private readonly routeTables = new Map<string, PluginRouteTable>();
  /** Keyed by plugin id; namespaced (`plugin:<id>:<name>`) CASL subjects this plugin declared.
   *  Lifecycle mirrors `routeTables`, not `indexerDescriptors`: kept across `unregister()`, dropped on `forget()`. */
  private readonly declaredPermissions = new Map<string, ReadonlySet<string>>();

  constructor(
    @InjectRepository(PluginPackage)
    private readonly packageRepo: Repository<PluginPackage>,
    @InjectRepository(PluginRegistration)
    private readonly registrationRepo: Repository<PluginRegistration>,
    private readonly processService: PluginProcessService,
    private readonly pluginJobs: PluginJobsService,
  ) {}

  async onModuleInit(): Promise<void> {
    // L0 — read before any plugin row is touched.
    if (arePluginsDisabled()) {
      this.logger.warn(`${FLIKS_PLUGINS_DISABLED_ENV}=1 — no plugin will be loaded`);
      return;
    }

    const packages = await this.packageRepo.find();
    for (const pkg of packages) {
      try {
        const result = await this.register(pkg);
        if (!result.ok) {
          this.logger.warn(`plugin "${result.pluginId}" not loaded (${result.reason}): ${result.detail}`);
        }
      } catch (err) {
        // One bad row must never take the app down at boot.
        this.logger.warn(`plugin "${pkg.pluginId}" failed to load: ${(err as Error).message}`);
      }
    }
  }

  /** Hot-reload entry point (install pipeline P4a). Same checks as boot load; idempotent on plugin id. */
  async register(pkg: PluginPackage): Promise<PluginRegistrationResult> {
    const manifest = pkg.manifest;

    // L1 (state.json quarantine) slots in here, ahead of the signature re-check — still has no owner.
    // L2
    const trust = await this.reverifyTrust(pkg);
    if (!trust.ok) return this.fail(pkg.pluginId, 'untrusted', trust.detail);

    // L3 (re-hash plugin.js from the loaded fd) happens inside `PluginProcessService.startFor`, below.
    // L4
    if (manifest.pluginApi !== PLUGIN_API_VERSION) {
      return this.fail(
        pkg.pluginId,
        'incompatible-api',
        `manifest declares pluginApi ${manifest.pluginApi}, running ${PLUGIN_API_VERSION}`,
      );
    }
    if (!semver.satisfies(CURRENT_FLIKS_VERSION, manifest.fliks)) {
      return this.fail(
        pkg.pluginId,
        'incompatible-fliks',
        `manifest requires fliks "${manifest.fliks}", running ${CURRENT_FLIKS_VERSION}`,
      );
    }

    const descriptorCheck = this.validateIndexerDescriptors(manifest.provides?.indexers ?? []);
    if (!descriptorCheck.ok) return this.fail(pkg.pluginId, descriptorCheck.reason, descriptorCheck.detail);

    // Structurally legal on `process` too, but only `data` fans out over HTTP —
    // `process` gets domain events pushed over its own socket instead.
    const webhookCheck = this.validateWebhookDeclarations(manifest.events ?? []);
    if (!webhookCheck.ok) return this.fail(pkg.pluginId, webhookCheck.reason, webhookCheck.detail);

    let declaredSubjects: ReadonlySet<string> = EMPTY_SUBJECT_SET;
    if (manifest.kind === 'process') {
      const permissionsCheck = this.validatePermissions(pkg.pluginId, manifest.permissions ?? []);
      if (!permissionsCheck.ok) return this.fail(pkg.pluginId, permissionsCheck.reason, permissionsCheck.detail);
      declaredSubjects = permissionsCheck.subjects;

      const jobsCheck = this.validateJobs(manifest.jobs ?? []);
      if (!jobsCheck.ok) return this.fail(pkg.pluginId, jobsCheck.reason, jobsCheck.detail);

      const routesCheck = this.validateRoutes(manifest.routes, declaredSubjects);
      if (!routesCheck.ok) return this.fail(pkg.pluginId, routesCheck.reason, routesCheck.detail);

      // Installed before running: what a plugin declares stays true while its process is
      // down, so a request to one of its routes can answer 503 instead of a bare Forbidden.
      this.replaceRouteTable(pkg.pluginId, manifest.routes);
      this.replaceDeclaredPermissions(pkg.pluginId, declaredSubjects);

      const activation = await this.activateProcess(pkg, manifest);
      if (!activation.ok) return activation;

      // Only now that the process is actually up — a cron for a plugin that failed to
      // spawn would fire into a "not running" no-op forever.
      this.pluginJobs.replaceFor(pkg.pluginId, jobsCheck.jobs);
    } else {
      // A tier switch on upgrade (process -> data, same plugin id) must not leave the
      // previous registration's crons or permission set behind.
      this.pluginJobs.dropFor(pkg.pluginId);
    }

    this.registry.set(pkg.pluginId, {
      pluginId: pkg.pluginId,
      version: pkg.version,
      kind: manifest.kind,
      manifest,
      signature: pkg.signature,
      verifiedByKeyId: pkg.verifiedByKeyId,
      archive: pkg.archive,
    });
    this.replaceIndexerDescriptors(pkg.pluginId, descriptorCheck.descriptors);
    this.replaceWebhookDeclarations(pkg.pluginId, manifest.kind === 'data' ? webhookCheck.declarations : []);
    this.replaceRouteTable(pkg.pluginId, manifest.kind === 'process' ? manifest.routes : []);
    this.replaceDeclaredPermissions(pkg.pluginId, manifest.kind === 'process' ? declaredSubjects : EMPTY_SUBJECT_SET);
    return { ok: true, pluginId: pkg.pluginId };
  }

  /** Uninstall: nothing the plugin declared is true any more, its routes included. */
  async forget(pluginId: string): Promise<void> {
    await this.unregister(pluginId);
    this.replaceRouteTable(pluginId, []);
    this.replaceDeclaredPermissions(pluginId, EMPTY_SUBJECT_SET);
  }

  /** Withdraws what the plugin offers and stops its process, but keeps its declared routes and
   *  permission set: a stopped plugin is unavailable, not forbidden. Its cron still stops here, though. */
  async unregister(pluginId: string): Promise<void> {
    await this.processService.stopFor(pluginId);
    this.pluginJobs.dropFor(pluginId);
    this.registry.delete(pluginId);
    this.replaceIndexerDescriptors(pluginId, []);
    this.replaceWebhookDeclarations(pluginId, []);
  }

  /** Persists the admin's enabled/disabled choice and starts or stops the process to match it. */
  async setEnabled(pkg: PluginPackage, enabled: boolean): Promise<PluginRegistrationResult> {
    const registration = await this.registrationRepo.findOne({ where: { pluginId: pkg.pluginId } });
    if (!registration) throw new NotFoundException(`plugin "${pkg.pluginId}" has no registration row`);
    registration.enabled = enabled;
    await this.registrationRepo.save(registration);

    if (!enabled) {
      await this.unregister(pkg.pluginId);
      return this.fail(pkg.pluginId, 'disabled', `plugin "${pkg.pluginId}" is disabled`);
    }
    return this.register(pkg);
  }

  /** Clears a tripped circuit breaker by swapping in a freshly-provisioned supervisor. */
  async restartProcess(pluginId: string): Promise<void> {
    await this.processService.restart(pluginId);
  }

  processStateOf(pluginId: string): SupervisorState | null {
    return this.processService.stateOf(pluginId);
  }

  processStatusMessageOf(pluginId: string): string {
    return this.processService.statusMessageOf(pluginId);
  }

  /** Loads or creates the `plugin_registrations` row (seeding it only on create),
   *  refreshes its cached manifest, then spawns unless the admin disabled it. */
  private async activateProcess(
    pkg: PluginPackage,
    manifest: ProcessPluginManifest,
  ): Promise<{ ok: true } | PluginRegistrationFailure> {
    let registration = await this.registrationRepo.findOne({ where: { pluginId: pkg.pluginId } });
    if (!registration) {
      registration = this.registrationRepo.create({
        pluginId: pkg.pluginId,
        ingestRoots: manifest.ingestRoots,
        scopes: manifest.scopes,
        enabled: true,
        manifest,
      });
    } else {
      registration.manifest = manifest;
    }
    await this.registrationRepo.save(registration);

    if (!registration.enabled) {
      return this.fail(pkg.pluginId, 'disabled', `plugin "${pkg.pluginId}" is disabled`);
    }

    const result = await this.processService.startFor(pkg);
    if (!result.ok) return this.fail(pkg.pluginId, result.reason, result.detail);
    return { ok: true };
  }

  list(): RegisteredPlugin[] {
    return [...this.registry.values()];
  }

  get(pluginId: string): RegisteredPlugin | undefined {
    return this.registry.get(pluginId);
  }

  /** The descriptor behind a namespaced `Indexer.implementation`, if that plugin is currently registered. */
  getIndexerDescriptor(implementationId: string): IndexerDescriptor | undefined {
    return this.indexerDescriptors.get(implementationId)?.descriptor;
  }

  /** Every indexer descriptor currently on offer, for the discovery route. */
  listIndexerDescriptors(): ({ implementationId: string; pluginId: string } & IndexerDescriptor)[] {
    return [...this.indexerDescriptors.entries()].map(([implementationId, { pluginId, descriptor }]) => ({
      implementationId,
      pluginId,
      ...descriptor,
    }));
  }

  /** The declared route matching this method+path for a registered `process` plugin, or
   *  `null` — no table (unregistered / `data` kind) and no match both refuse identically. */
  resolveRoute(pluginId: string, method: string, path: string): ResolvedPluginRoute | null {
    return this.routeTables.get(pluginId)?.resolve(method, path) ?? null;
  }

  /** The namespaced CASL subjects this plugin declared — empty if unregistered, `data`, or none declared.
   *  `PluginRouteGuard` scopes every check to exactly this, so a route never authorizes against another plugin's subject. */
  declaredPermissionsFor(pluginId: string): ReadonlySet<string> {
    return this.declaredPermissions.get(pluginId) ?? EMPTY_SUBJECT_SET;
  }

  /** Every registered webhook subscribed to `eventType` — the dispatcher's fan-out list. */
  listWebhooksForEvent(eventType: string): { pluginId: string; webhook: string }[] {
    const out: { pluginId: string; webhook: string }[] = [];
    for (const [pluginId, declarations] of this.webhookDeclarations) {
      for (const d of declarations) {
        if (d.event === eventType) out.push({ pluginId, webhook: d.webhook });
      }
    }
    return out;
  }

  /** Drops this plugin's previous webhooks (if any) and installs `declarations` in their place. */
  private replaceWebhookDeclarations(pluginId: string, declarations: { event: PluginWebhookEventName; webhook: string }[]): void {
    if (declarations.length === 0) this.webhookDeclarations.delete(pluginId);
    else this.webhookDeclarations.set(pluginId, declarations);
  }

  /** Drops this plugin's previous descriptors (if any) and installs `descriptors` in their place. */
  private replaceIndexerDescriptors(pluginId: string, descriptors: IndexerDescriptor[]): void {
    for (const [id, entry] of this.indexerDescriptors) {
      if (entry.pluginId === pluginId) this.indexerDescriptors.delete(id);
    }
    for (const descriptor of descriptors) {
      this.indexerDescriptors.set(buildIndexerImplementationId(pluginId, descriptor.key), { pluginId, descriptor });
    }
  }

  /** Drops this plugin's previous declared-permission set (if any) and installs `subjects` in its place. */
  private replaceDeclaredPermissions(pluginId: string, subjects: ReadonlySet<string>): void {
    if (subjects.size === 0) this.declaredPermissions.delete(pluginId);
    else this.declaredPermissions.set(pluginId, subjects);
  }

  /** Drops this plugin's previous route table (if any) and compiles `routes` into a fresh one. */
  private replaceRouteTable(pluginId: string, routes: PluginRoute[]): void {
    if (routes.length === 0) this.routeTables.delete(pluginId);
    else this.routeTables.set(pluginId, new PluginRouteTable(routes));
  }

  /**
   * `manifest.provides.indexers` is untrusted JSON (`unknown[]` at the type
   * level — see `manifest.ts`), so each entry is read defensively rather
   * than trusted as an `IndexerDescriptor`. Each violation gets its own
   * reason so a refusal is attributable, mirroring
   * `validateDataTierManifest`'s one-code-per-key style.
   */
  private validateIndexerDescriptors(
    raw: unknown[],
  ):
    | { ok: true; descriptors: IndexerDescriptor[] }
    | { ok: false; reason: PluginRegistrationFailureReason; detail: string } {
    const descriptors: IndexerDescriptor[] = [];
    const seenKeys = new Set<string>();
    for (const entry of raw) {
      const d = (entry ?? {}) as Partial<IndexerDescriptor>;
      const key = typeof d.key === 'string' ? d.key : '';
      const driverApi = typeof d.driverApi === 'string' ? d.driverApi : '';
      const endpoint = typeof d.endpoint === 'string' ? d.endpoint : '';
      const name = typeof d.name === 'string' ? d.name : '';
      const settings = Array.isArray(d.settings) ? d.settings : [];

      if (!SUPPORTED_INDEXER_DRIVER_APIS.has(driverApi)) {
        return {
          ok: false,
          reason: 'unsupported-indexer-driver',
          detail: `descriptor "${key}" needs driverApi "${driverApi}", which core does not support (supported: ${[...SUPPORTED_INDEXER_DRIVER_APIS].join(', ')})`,
        };
      }
      if (!key || key.includes(INDEXER_ID_SEPARATOR)) {
        return {
          ok: false,
          reason: 'invalid-indexer-key',
          detail: `indexer key "${key}" is empty or contains "${INDEXER_ID_SEPARATOR}"`,
        };
      }
      if (seenKeys.has(key)) {
        return { ok: false, reason: 'invalid-indexer-key', detail: `duplicate indexer key "${key}"` };
      }
      seenKeys.add(key);
      if (!isAbsoluteHttpUrl(endpoint)) {
        return {
          ok: false,
          reason: 'invalid-indexer-endpoint',
          detail: `descriptor "${key}" has an invalid endpoint "${endpoint}"`,
        };
      }
      descriptors.push({ key, name, driverApi, endpoint, settings });
    }
    return { ok: true, descriptors };
  }

  /**
   * `manifest.events` is untrusted JSON like `provides.indexers`, so each entry
   * is read defensively. `event` must be a name from the webhook catalog; `webhook`
   * must be an `https://` URL whose host, when it's an IP literal, isn't internal.
   * A bare hostname is accepted here — DNS isn't resolved at install time, and
   * resolving it wouldn't help anyway (it can repoint after the check); the
   * dispatcher re-resolves and re-checks on every delivery instead.
   */
  private validateWebhookDeclarations(
    raw: unknown[],
  ):
    | { ok: true; declarations: { event: PluginWebhookEventName; webhook: string }[] }
    | { ok: false; reason: PluginRegistrationFailureReason; detail: string } {
    const declarations: { event: PluginWebhookEventName; webhook: string }[] = [];
    for (const entry of raw) {
      const d = entry as { event?: unknown; webhook?: unknown } | null | undefined;
      const event = typeof d?.event === 'string' ? d.event : '';
      const webhook = typeof d?.webhook === 'string' ? d.webhook : '';

      if (!WEBHOOK_EVENT_NAMES.has(event)) {
        return { ok: false, reason: 'invalid-webhook-event', detail: `event "${event}" is not a recognised domain event` };
      }
      let url: URL;
      try {
        url = new URL(webhook);
      } catch {
        return { ok: false, reason: 'invalid-webhook-url', detail: `webhook "${webhook}" is not a valid URL` };
      }
      if (url.protocol !== 'https:') {
        return { ok: false, reason: 'insecure-webhook-scheme', detail: `webhook "${webhook}" must use https, got "${url.protocol}"` };
      }
      if (net.isIP(url.hostname) !== 0 && isInternalAddress(url.hostname)) {
        return { ok: false, reason: 'internal-webhook-host', detail: `webhook host "${url.hostname}" is an internal address` };
      }
      declarations.push({ event: event as PluginWebhookEventName, webhook });
    }
    return { ok: true, declarations };
  }

  /**
   * `manifest.permissions` is untrusted JSON like `provides.indexers`, so each entry is read
   * defensively. `PLUGIN_PERMISSION_NAME_PATTERN`'s charset alone rejects every reserved-looking
   * or foreign-plugin-shaped name — no `: . * space` or uppercase survives it. The namespace
   * prefix itself always comes from `pkg.pluginId`, never from the manifest, so a name can
   * never widen into another plugin's subject or a core one.
   */
  private validatePermissions(
    pluginId: string,
    raw: unknown[],
  ): { ok: true; subjects: ReadonlySet<string> } | { ok: false; reason: PluginRegistrationFailureReason; detail: string } {
    const subjects = new Set<string>();
    const seen = new Set<string>();
    for (const entry of raw) {
      const name = typeof entry === 'string' ? entry : '';
      if (!PLUGIN_PERMISSION_NAME_PATTERN.test(name)) {
        return { ok: false, reason: 'invalid-permission', detail: `permission ${JSON.stringify(name)} is not a legal permission name` };
      }
      if (seen.has(name)) {
        return { ok: false, reason: 'invalid-permission', detail: `duplicate permission "${name}"` };
      }
      seen.add(name);
      subjects.add(pluginPermissionSubject(pluginId, name));
    }
    return { ok: true, subjects };
  }

  /**
   * `manifest.jobs` is untrusted JSON like `provides.indexers`. Each violation class gets its own
   * reason. `CORE_JOB_NAME_SET` mirrors `SchedulerService.SCHEDULERS`'s names — a plugin job can
   * never shadow one, since the merged admin listing and manual trigger would become ambiguous.
   */
  private validateJobs(
    raw: unknown[],
  ): { ok: true; jobs: PluginJob[] } | { ok: false; reason: PluginRegistrationFailureReason; detail: string } {
    const jobs: PluginJob[] = [];
    const seen = new Set<string>();
    for (const entry of raw) {
      const j = (entry ?? {}) as Partial<PluginJob>;
      const name = typeof j.name === 'string' ? j.name : '';
      const cron = typeof j.cron === 'string' ? j.cron : '';
      const triggerable = j.triggerable;
      const labelKey = typeof j.labelKey === 'string' ? j.labelKey : '';

      if (!name || seen.has(name)) {
        return {
          ok: false,
          reason: 'invalid-job-name',
          detail: !name ? 'job name must not be empty' : `duplicate job name "${name}"`,
        };
      }
      seen.add(name);
      if (CORE_JOB_NAME_SET.has(name)) {
        return { ok: false, reason: 'job-name-conflict', detail: `job "${name}" collides with a core scheduler job` };
      }
      try {
        CronExpressionParser.parse(cron);
      } catch (err) {
        return {
          ok: false,
          reason: 'invalid-job-cron',
          detail: `job "${name}" has an invalid cron expression "${cron}": ${(err as Error).message}`,
        };
      }
      if (typeof triggerable !== 'boolean') {
        return { ok: false, reason: 'invalid-job-triggerable', detail: `job "${name}" has a non-boolean "triggerable"` };
      }
      if (!labelKey) {
        return { ok: false, reason: 'invalid-job-label', detail: `job "${name}" has an empty "labelKey"` };
      }
      jobs.push({ name, cron, triggerable, labelKey });
    }
    return { ok: true, jobs };
  }

  /** The deep, semantic route check `manifest-parser.ts` defers (its field-type check already ran). */
  private validateRoutes(
    routes: PluginRoute[],
    declaredSubjects: ReadonlySet<string>,
  ): { ok: true } | { ok: false; reason: PluginRegistrationFailureReason; detail: string } {
    const seen = new Set<string>();
    for (const route of routes) {
      const method = route.method.toUpperCase();
      if (!KNOWN_HTTP_METHODS.has(method)) {
        return { ok: false, reason: 'invalid-route-method', detail: `route method "${route.method}" is not a known HTTP verb` };
      }
      if (!route.path.startsWith('/')) {
        return { ok: false, reason: 'invalid-route-path', detail: `route path "${route.path}" must start with "/"` };
      }
      let keys: Keys;
      try {
        keys = pathToRegexp(route.path).keys;
      } catch (err) {
        return { ok: false, reason: 'invalid-route-path', detail: `route path "${route.path}" is invalid: ${(err as Error).message}` };
      }
      if (!parseDeclaredPolicy(route.policy, declaredSubjects)) {
        return { ok: false, reason: 'invalid-route-policy', detail: `route policy "${route.policy}" is not a recognised action:subject pair` };
      }
      if (route.objectGuard !== undefined) {
        const parsedGuard = parseObjectGuard(route.objectGuard);
        if (!parsedGuard || !keys.some((k) => k.name === parsedGuard.paramName)) {
          return {
            ok: false,
            reason: 'invalid-route-object-guard',
            detail: `route objectGuard "${route.objectGuard}" on path "${route.path}" does not resolve to a known guard and param`,
          };
        }
      }
      const dedupeKey = `${method} ${route.path}`;
      if (seen.has(dedupeKey)) {
        return { ok: false, reason: 'duplicate-route', detail: `duplicate route "${dedupeKey}"` };
      }
      seen.add(dedupeKey);
    }
    return { ok: true };
  }

  /** Every failure path funnels here, so a failing re-registration can never leave a stale entry active. */
  private fail(pluginId: string, reason: PluginRegistrationFailureReason, detail: string): PluginRegistrationFailure {
    this.registry.delete(pluginId);
    this.replaceIndexerDescriptors(pluginId, []);
    this.replaceWebhookDeclarations(pluginId, []);
    // No failure reason leaves a process running, so its cron never should either.
    this.pluginJobs.dropFor(pluginId);
    if (!INSTALLED_BUT_NOT_RUNNING.has(reason)) {
      this.replaceRouteTable(pluginId, []);
      this.replaceDeclaredPermissions(pluginId, EMPTY_SUBJECT_SET);
    }
    return { ok: false, pluginId, reason, detail };
  }

  /**
   * Re-verify against `verifiedByKeyId` specifically — never "any trusted key" — so a
   * revoked/removed key fails the plugin rather than silently falling back to another.
   * A package that was never signed against a known key at install (unsigned/unverified)
   * has nothing to re-check here and passes through.
   */
  private async reverifyTrust(pkg: PluginPackage): Promise<{ ok: true } | { ok: false; detail: string }> {
    if (!pkg.verifiedByKeyId) return { ok: true };

    const key = OFFICIAL_KEYS.get(pkg.verifiedByKeyId);
    if (!key) {
      return { ok: false, detail: `key "${pkg.verifiedByKeyId}" is no longer in the trust store` };
    }

    try {
      const entries = await readArchiveEntries(pkg.archive, new Set(['plugin.json', 'plugin.json.sig']));
      const manifestBytes = entries.get('plugin.json');
      const sigText = entries.get('plugin.json.sig')?.toString('utf8').trim();
      if (!manifestBytes || !sigText) {
        return { ok: false, detail: 'archive is missing plugin.json or its signature' };
      }
      const signature = Buffer.from(sigText, 'base64');
      // Scope the check to exactly this one key by passing it as the sole candidate.
      const result = resolveTrust(manifestBytes, signature, new Map([[pkg.verifiedByKeyId, key]]), new Map());
      if (result.trust !== 'official') {
        return { ok: false, detail: `signature no longer verifies against key "${pkg.verifiedByKeyId}"` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: `archive unreadable: ${(err as Error).message}` };
    }
  }
}
