/**
 * Wire protocol for the two unix sockets between core and a `process`
 * plugin: newline-delimited JSON, one object per line.
 *
 * This directory is a standalone island: it imports nothing from
 * `backend/src` outside itself (no NestJS, no TypeORM, no entity class),
 * because the plugin repo compiles this same source as its contract.
 */

/** A request frame. `i` pairs it with its `Res`; `m` is the dotted method name. */
export interface Req {
  i: number;
  m: string;
  p?: unknown;
}

/** The reply to a `Req` with the same `i`. Exactly one of `r`/`e` is present. */
export interface Res {
  i: number;
  r?: unknown;
  e?: { c: string; m: string };
}

/** A fire-and-forget frame: no `i`, no reply is ever sent for it. */
export type Note<P = unknown> = { m: string; p?: P };

/** Per-frame size ceiling. An oversize frame is a protocol violation and SIGKILLs the plugin. */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/**
 * The newest version core speaks, and the one a new manifest should declare. Core answers each
 * plugin in the version that plugin's own manifest declares, so a bump here orphans nobody.
 * Within one value the method set is additive-only; any removal or semantic change bumps it.
 */
export const PLUGIN_API_VERSION = 1;

/**
 * Every value core still accepts from a manifest, newest last. Retiring one is what orphans the
 * plugins that declare it, so a bump adds an entry and a later release drops the oldest — the
 * window in between is when authors republish.
 */
export const SUPPORTED_PLUGIN_API_VERSIONS: readonly number[] = [0, 1];

/**
 * Environment core sets on every spawn (see `supervisor/spawn-plan.ts`) — the only way in
 * for a `process` plugin, since core never passes `...process.env`. Every value here is a
 * plain string; only `FLIKS_API_VERSION` has a typed counterpart ({@link PLUGIN_API_VERSION}).
 */
export interface PluginSpawnEnv {
  /** Random per spawn, known only to core and this child. Echo it back as `hello`'s `token` —
   *  proof the responder is the process core spawned, not an impostor on the socket. */
  FLIKS_PLUGIN_TOKEN: string;
  /** Unix socket this plugin dials to make its `PluginHostApi` calls. */
  FLIKS_CORE_SOCK: string;
  /** Unix socket this plugin dials to *receive* core's `PluginApi` calls
   *  (`hello`, `health`, `http`, `job`, `event`, `config`, `shutdown`). Core listens on both
   *  sockets; the plugin connects to both and never binds one of its own. */
  FLIKS_PLUGIN_SOCK: string;
  /** This plugin's own Postgres connection string; `''` when its manifest declared no schema. */
  FLIKS_DB_URL: string;
  /** This manifest's `id`, verbatim. */
  FLIKS_PLUGIN_ID: string;
  /** {@link PLUGIN_API_VERSION}, stringified — compared for exact equality, never a range. */
  FLIKS_API_VERSION: string;
  /** `${dir}/data` — the child's cwd, and the one path its sandbox may write to. */
  HOME: string;
  PATH: string;
  NODE_ENV: string;
  TZ: string;
}

/**
 * Every `plugin.<id>.<key>` admin setting also arrives re-keyed as an env var: strip the
 * `plugin.<id>.` prefix, upper-case what remains, replace every character outside
 * `[A-Z0-9_]` with `_`, and prepend `FLIKS_CFG_` (see `reKeyConfig` in `supervisor/spawn-plan.ts`).
 * Not a fixed set — read whichever `FLIKS_CFG_*` names your own manifest's settings resolve to.
 */

/**
 * The deadlines and ceilings a plugin must design against. Core enforces these; a plugin that
 * exceeds one is killed or has its call abandoned, so they belong on the published surface rather
 * than in core's private configuration. `supervisor-deadlines.spec.ts` fails if they drift from
 * what the supervisor actually applies.
 */
export const PLUGIN_DEADLINES_MS = {
  /** From spawn to a `hello` reply. Exceeded: the child is killed and restarted. */
  handshake: 10_000,
  /** Interval between `health` calls, and how long each has to answer. */
  healthInterval: 15_000,
  healthReply: 3_000,
  /** Ceiling on one host call, unless the method appears in {@link HOST_CALL_DEADLINE_OVERRIDES_MS}. */
  hostCall: 8_000,
  /** Ceiling on one proxied `http` route into the plugin. A route fanning out to third-party
   *  upstreams is allowed to be slow, so the plugin's own per-upstream timeouts have to fit
   *  under this — and a browser behind a reverse proxy gets a 504 long before this anyway. */
  pluginCall: 180_000,
  /**
   * Ceiling on one `job` call. Not `pluginCall`: that value is sized for a request a browser is
   * waiting on, and a cron sweep has neither a browser nor a proxy in front of it. Its duration
   * scales with library size — a few hundred candidates at seconds of indexer search each passes
   * three minutes long before it is finished — so inheriting an interactive route's ceiling made
   * core report every real sweep as failed, and release its overlap guard while it still ran.
   */
  job: 60 * 60_000,
  /** After `shutdown` is answered (or not), before SIGTERM, then before SIGKILL. */
  shutdownRpc: 3_000,
  sigtermGrace: 2_000,
} as const;

/** Host methods whose own work is not a lookup, so they are allowed longer than {@link PLUGIN_DEADLINES_MS.hostCall}. */
export const HOST_CALL_DEADLINE_OVERRIDES_MS: Readonly<Record<string, number>> = {
  'library.ingest': 30 * 60_000,
};

/** Output above this, per minute, is dropped with one warning — a plugin must rate-limit its own logs. */
export const PLUGIN_LOG_CAP_BYTES_PER_MINUTE = 64 * 1024;

/** `memoryMb`'s default when a manifest declares none. It caps the V8 old space, not the process RSS. */
export const PLUGIN_DEFAULT_MEMORY_MB = 256;
