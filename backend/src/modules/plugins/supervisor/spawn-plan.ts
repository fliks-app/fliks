import { spawnSync, type SpawnOptions } from 'child_process';
import { PLUGIN_API_VERSION } from '../../../common/plugin-contract';

let cachedPermissionFlag: string | null = null;

/**
 * `--permission` is the plan's flag (stable on the NodeSource 24 this server
 * runs); older Nodes need `--experimental-permission`. Probed once and cached.
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

export interface SpawnPlanInput {
  dir: string;
  memoryMb: number;
  coreSockPath: string;
  pluginSockPath: string;
  token: string;
  pluginId: string;
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
  const homeDir = `${input.dir}/data`;
  const nodeArgv = [
    resolvePermissionFlag(),
    `--allow-fs-read=${input.dir}`,
    `--allow-fs-write=${homeDir}`,
    `--max-old-space-size=${input.memoryMb}`,
    '--disable-proto=delete',
    `${input.dir}/plugin.js`,
  ];

  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    NODE_ENV: 'production',
    TZ: process.env.TZ ?? 'UTC',
    HOME: homeDir,
    FLIKS_CORE_SOCK: input.coreSockPath,
    FLIKS_PLUGIN_SOCK: input.pluginSockPath,
    FLIKS_PLUGIN_TOKEN: input.token,
    FLIKS_PLUGIN_ID: input.pluginId,
    FLIKS_API_VERSION: String(PLUGIN_API_VERSION),
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
    ...(root ? { uid: 65534, gid: 65534 } : {}),
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
