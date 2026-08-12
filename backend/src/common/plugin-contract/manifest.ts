import type { UiContribution, ConfigPage, ReleasePickerRoutes } from './ui-contribution';
import type { PluginScope } from './principal';

/**
 * Domain event names a `data` plugin's webhook may subscribe to. Mirrors
 * `DomainEvent['type']` in `modules/scheduler/events.service.ts` verbatim: this
 * island may not import from the rest of the backend (see the module doc below),
 * so the catalog is restated here and `PluginRegistryService` asserts the two
 * stay in sync.
 */
export const PLUGIN_WEBHOOK_EVENT_NAMES = [
  'media.imported',
  'media.monitored.changed',
  'media.season.monitored.changed',
  'media.removed',
  'media.files.imported',
  'media.acquisition.requested',
  'acquisition.grabbed',
  'request.created',
  'request.approved',
  'library.scan.completed',
  'settings.changed',
] as const;

export type PluginWebhookEventName = (typeof PLUGIN_WEBHOOK_EVENT_NAMES)[number];

/**
 * One `events[]` entry: POST the event to `webhook` when `event` fires. Both
 * fields are optional at the type level — a manifest is untrusted JSON, so
 * `PluginRegistryService` validates every entry before believing it.
 */
export interface PluginWebhookDeclaration {
  event: PluginWebhookEventName;
  /** An absolute https URL. Validated again at registration and at every
   *  dispatch: a manifest is untrusted JSON and DNS can move under it. */
  webhook: string;
}

/**
 * `data` ships JSON descriptors and executes nothing; `process` ships one
 * bundled JS file that core spawns as a child process. The baseline's
 * third tier, `bundled`, is deleted: in-repo code is just core now.
 */
export type PluginKind = 'data' | 'process';

/** `schedulers[]` renamed: core owns the cron and calls `job` on the trigger. */
export interface PluginJob {
  name: string;
  cron: string;
  triggerable: boolean;
  labelKey: string;
}

/** One proxied HTTP route a `process` plugin owns. Both fields are install-time validations. */
export interface PluginRoute {
  method: string;
  path: string;
  policy: string;
  objectGuard?: string;
}

/**
 * Fields unchanged between tiers. `events` and `i18n` carry shapes owned by
 * a pre-existing baseline schema not reproduced here; kept structurally
 * opaque rather than guessed.
 */
interface PluginManifestBase {
  id: string;
  pluginApi: number;
  name: string;
  version: string;
  /** Semver range with a mandatory upper bound, e.g. ">=2.1.0 <3.0.0". */
  fliks: string;
  author: string;
  description: string;
  license: string;
  logo: string;
  homepage?: string;
  ui?: {
    contributions?: UiContribution[];
    configPages?: ConfigPage[];
    /** Fills core's release picker. Every route here must also be declared in
     *  `provides.routes[]`, so it carries a policy like any other. */
    releasePicker?: ReleasePickerRoutes;
  };
  /** `data`-tier outbound notifications only. */
  events?: PluginWebhookDeclaration[];
  i18n?: Record<string, Record<string, string>>;
}

/** A `data` manifest: no code, so none of the `process`-only keys are legal on it. */
export interface DataPluginManifest extends PluginManifestBase {
  kind: 'data';
}

/** A `process` manifest: owns a schema, routes, jobs and an ingest allowlist. */
export interface ProcessPluginManifest extends PluginManifestBase {
  kind: 'process';
  /** The only legal value; not omittable. */
  runtime: 'node';
  /** `--max-old-space-size`; core caps at 1024. */
  memoryMb: number;
  /** sha256 of every archive entry but the manifest and its signature. */
  files: Record<string, string>;
  database: { schema: boolean; coreRefs: string[] };
  routes: PluginRoute[];
  scopes: PluginScope[];
  /** Allowlist for `library.ingest` paths. */
  ingestRoots: string[];
  jobs?: PluginJob[];
  /** Legal on `process`, refused on `data`; item shape is the pre-existing baseline's. */
  permissions?: string[];
  /** Legal on `process`, refused on `data`; item shape is the pre-existing baseline's. */
  checklist?: string[];
}

/**
 * The manifest, discriminated on `kind`. A `data` object literal carrying
 * `routes` (or any other `process`-only key) fails to typecheck: narrowing
 * on `kind: 'data'` selects `DataPluginManifest`, which has no such property.
 */
export type PluginManifest = DataPluginManifest | ProcessPluginManifest;
