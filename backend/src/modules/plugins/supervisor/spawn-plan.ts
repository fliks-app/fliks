import { spawnSync, type SpawnOptions } from 'child_process';
import { chmodSync, chownSync, mkdirSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { type PluginSpawnEnv } from '../../../common/plugin-contract';

/** The unprivileged identity a plugin child drops to when core runs as root, used when no uid was
 *  allocated for it. Sharing it is what lets one child read another's `/proc` entry. */
export const PLUGIN_CHILD_UID = 65534;

/** Shared by every child: the runtime directory is group-traversable so each can reach its own
 *  socket, while the 0600 socket and 0700 data directory are owned by the plugin's own uid. */
export const PLUGIN_CHILD_GID = 65534;

/** Allocation range for per-plugin uids. Below `nobody`, above anything a base image assigns. */
export const PLUGIN_UID_MIN = 60000;
export const PLUGIN_UID_MAX = 64999;

/** Lowest free uid in the range, or null when every one of them is taken. */
export function allocateChildUid(taken: readonly number[]): number | null {
  const used = new Set(taken);
  for (let uid = PLUGIN_UID_MIN; uid <= PLUGIN_UID_MAX; uid++) {
    if (!used.has(uid)) return uid;
  }
  return null;
}

let cachedPermissionFlag: string | null = null;

/**
 * `--permission` is the flag name to use (stable on the NodeSource 24 this
 * server runs); older Nodes need `--experimental-permission`. Probed once and cached.
 */
export function resolvePermissionFlag(): string {
  if (cachedPermissionFlag) return cachedPermissionFlag;
  const probe = spawnSync(process.execPath, ['--permission', '-e', '0']);
  cachedPermissionFlag = probe.status === 0 ? '--permission' : '--experimental-permission';
  return cachedPermissionFlag;
}

/** Root is an opportunistic bonus (Decision 25) — the drop only happens when it's true. */
export function shouldDropPrivileges(platform: NodeJS.Platform, getuid?: () => number): boolean {
  return platform !== 'win32' && typeof getuid === 'function' && getuid() === 0;
}

/**
 * A dropped child must reach its own code and its data dir through the kernel, not just
 * `--allow-fs-*`: extraction writes 0600 root-owned files into a 0700 directory. Code stays
 * root-owned and read-only to the child; `dataDir` (outside the code tree, keyed by plugin id —
 * see `pluginDataDir`) is what changes hands. Its shared parent is `0710`, group-owned by the
 * drop gid: a dropped child can reach its own known path but not list a sibling plugin's.
 */
export function prepareDirForDroppedChild(
  dir: string,
  dataDir: string,
  uid = PLUGIN_CHILD_UID,
  gid = PLUGIN_CHILD_GID,
): void {
  const dataParent = dirname(dataDir);
  mkdirSync(dataParent, { recursive: true });
  chmodSync(dataParent, 0o710);
  chownSync(dataParent, -1, gid);
  mkdirSync(dataDir, { recursive: true });
  chmodSync(dir, 0o755);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile()) chmodSync(join(dir, entry.name), 0o644);
  }
  chownSync(dataDir, uid, gid);
  chmodSync(dataDir, 0o700);
}

export interface SpawnPlanInput {
  dir: string;
  /** This plugin's own uid, so a sibling cannot read its `/proc` entry or open its socket. */
  childUid: number;
  /** `pluginDataDir(pluginId)` — outside `dir`, so it outlives this spawn's code tree. */
  dataDir: string;
  memoryMb: number;
  coreSockPath: string;
  pluginSockPath: string;
  token: string;
  pluginId: string;
  /** The version this plugin's manifest declares, which is the one core answers it in. */
  pluginApi: number;
  dbUrl?: string;
  /** `plugin.<id>.*` admin settings, re-keyed to `FLIKS_CFG_*` env vars. */
  config?: Record<string, string>;
}

export interface SpawnPlan {
  /** What is actually exec'd — `setpriv` on Linux, wrapping the node invocation below. */
  command: string;
  args: string[];
  /** The node-level identity the kernel reports via cmdline once setpriv (if any) has exec'd into it. */
  expectedCmdline: string[];
  env: NodeJS.ProcessEnv;
  options: SpawnOptions;
}

function reKeyConfig(pluginId: string, config: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const prefix = `plugin.${pluginId}.`;
  for (const [key, value] of Object.entries(config)) {
    const suffix = key.startsWith(prefix) ? key.slice(prefix.length) : key;
    out[`FLIKS_CFG_${suffix.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`] = value;
  }
  return out;
}

/** Builds the exact argv/env from "The spawn call and the supervisor" — never `...process.env`. */
export function buildSpawnPlan(input: SpawnPlanInput): SpawnPlan {
  const homeDir = input.dataDir;
  const nodeArgv = [
    resolvePermissionFlag(),
    `--allow-fs-read=${input.dir}`,
    // The data dir sits outside the code tree, so it needs its own read grant to be readable back.
    `--allow-fs-read=${homeDir}`,
    `--allow-fs-write=${homeDir}`,
    `--max-old-space-size=${input.memoryMb}`,
    '--disable-proto=delete',
    `${input.dir}/plugin.js`,
  ];

  // Typed off the contract, so a variable renamed or dropped here stops compiling.
  const env: PluginSpawnEnv & NodeJS.ProcessEnv = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    NODE_ENV: 'production',
    TZ: process.env.TZ ?? 'UTC',
    HOME: homeDir,
    FLIKS_CORE_SOCK: input.coreSockPath,
    FLIKS_PLUGIN_SOCK: input.pluginSockPath,
    FLIKS_PLUGIN_TOKEN: input.token,
    FLIKS_PLUGIN_ID: input.pluginId,
    FLIKS_API_VERSION: String(input.pluginApi),
    FLIKS_DB_URL: input.dbUrl ?? '',
    ...reKeyConfig(input.pluginId, input.config ?? {}),
  };

  const root = shouldDropPrivileges(process.platform, process.getuid?.bind(process));
  const options: SpawnOptions = {
    cwd: homeDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    windowsHide: true,
    env,
    ...(root ? { uid: input.childUid, gid: PLUGIN_CHILD_GID } : {}),
  };

  const expectedCmdline = [process.execPath, ...nodeArgv];
  // setpriv execs into the target in place (same pid, cmdline becomes the node
  // invocation) — free on Linux, closes setuid escalation, works unprivileged.
  if (process.platform === 'linux') {
    return {
      command: 'setpriv',
      args: ['--no-new-privs', '--', process.execPath, ...nodeArgv],
      expectedCmdline,
      env,
      options,
    };
  }
  return { command: process.execPath, args: nodeArgv, expectedCmdline, env, options };
}
