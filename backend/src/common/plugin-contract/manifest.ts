import type { UiContribution, ConfigPage } from './ui-contribution';
import type { PluginScope } from './principal';

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
 * Fields unchanged between tiers. `provides`, `events` and `i18n` carry
 * shapes owned by a pre-existing baseline schema not reproduced here
 * (e.g. `IndexerDescriptor`); kept structurally opaque rather than guessed.
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
  provides?: Record<string, unknown>;
  ui?: {
    contributions?: UiContribution[];
    configPages?: ConfigPage[];
  };
  /** `data`-tier outbound notifications only. */
  events?: { webhook?: string }[];
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
  /** URL aliases core keeps for one major version. */
  legacyPaths?: Record<string, string>;
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
