import { PLUGIN_API_VERSION } from '../../../common/plugin-contract';
import { buildSpawnPlan, resolvePermissionFlag, shouldDropPrivileges } from './spawn-plan';

const EXPECTED_ENV_KEYS = [
  'PATH',
  'NODE_ENV',
  'TZ',
  'HOME',
  'FLIKS_CORE_SOCK',
  'FLIKS_PLUGIN_SOCK',
  'FLIKS_PLUGIN_TOKEN',
  'FLIKS_PLUGIN_ID',
  'FLIKS_API_VERSION',
  'FLIKS_DB_URL',
].sort();

describe('resolvePermissionFlag', () => {
  it('resolves to a flag this node build actually accepts', () => {
    expect(['--permission', '--experimental-permission']).toContain(resolvePermissionFlag());
  });
});

describe('shouldDropPrivileges', () => {
  it('is false on win32 regardless of uid', () => {
    expect(shouldDropPrivileges('win32', () => 0)).toBe(false);
  });
  it('is false when not root', () => {
    expect(shouldDropPrivileges('linux', () => 1000)).toBe(false);
  });
  it('is true only for uid 0 on a non-Windows platform', () => {
    expect(shouldDropPrivileges('linux', () => 0)).toBe(true);
  });
  it('is false when getuid is unavailable (Windows has none)', () => {
    expect(shouldDropPrivileges('linux', undefined)).toBe(false);
  });
});

describe('buildSpawnPlan', () => {
  const baseInput = {
    dir: '/tmp/plugin-x',
    memoryMb: 256,
    coreSockPath: '/tmp/plugin-x.core.sock',
    pluginSockPath: '/tmp/plugin-x.plugin.sock',
    token: 'the-token',
    pluginId: 'demo',
  };

  it('never spreads process.env — the env is exactly the allowlist plus FLIKS_CFG_* re-keys', () => {
    process.env.PLUGIN_SUPERVISOR_TEST_LEAK = 'should-not-appear';
    const plan = buildSpawnPlan(baseInput);
    expect(Object.keys(plan.env).sort()).toEqual(EXPECTED_ENV_KEYS);
    expect(plan.env.PLUGIN_SUPERVISOR_TEST_LEAK).toBeUndefined();
    delete process.env.PLUGIN_SUPERVISOR_TEST_LEAK;
  });

  it('carries the exact spawn values', () => {
    const plan = buildSpawnPlan(baseInput);
    expect(plan.env.FLIKS_CORE_SOCK).toBe(baseInput.coreSockPath);
    expect(plan.env.FLIKS_PLUGIN_SOCK).toBe(baseInput.pluginSockPath);
    expect(plan.env.FLIKS_PLUGIN_TOKEN).toBe(baseInput.token);
    expect(plan.env.FLIKS_PLUGIN_ID).toBe(baseInput.pluginId);
    expect(plan.env.FLIKS_API_VERSION).toBe(String(PLUGIN_API_VERSION));
    expect(plan.env.HOME).toBe(`${baseInput.dir}/data`);
    expect(plan.env.NODE_ENV).toBe('production');
  });

  it('re-keys plugin.<id>.* config into FLIKS_CFG_*', () => {
    const plan = buildSpawnPlan({
      ...baseInput,
      config: { 'plugin.demo.minSeeders': '5', 'plugin.demo.some-key': 'v', unrelated: 'kept-as-is' },
    });
    expect(plan.env.FLIKS_CFG_MINSEEDERS).toBe('5');
    expect(plan.env.FLIKS_CFG_SOME_KEY).toBe('v');
    expect(plan.env.FLIKS_CFG_UNRELATED).toBe('kept-as-is');
  });

  it('builds the node argv verbatim from the plan', () => {
    const plan = buildSpawnPlan(baseInput);
    expect(plan.expectedCmdline).toEqual([
      process.execPath,
      resolvePermissionFlag(),
      `--allow-fs-read=${baseInput.dir}`,
      `--allow-fs-write=${baseInput.dir}/data`,
      `--max-old-space-size=${baseInput.memoryMb}`,
      '--disable-proto=delete',
      `${baseInput.dir}/plugin.js`,
    ]);
  });

  it('wraps with setpriv on Linux, execs the node argv unwrapped elsewhere', () => {
    const plan = buildSpawnPlan(baseInput);
    if (process.platform === 'linux') {
      expect(plan.command).toBe('setpriv');
      expect(plan.args.slice(0, 2)).toEqual(['--no-new-privs', '--']);
      expect(plan.args.slice(2)).toEqual(plan.expectedCmdline);
    } else {
      expect(plan.command).toBe(process.execPath);
      expect(plan.args).toEqual(plan.expectedCmdline.slice(1));
    }
  });

  it('does not set uid/gid when not root', () => {
    const plan = buildSpawnPlan(baseInput);
    expect(plan.options.uid).toBeUndefined();
    expect(plan.options.gid).toBeUndefined();
  });

  it('cwd is the plugin data dir, stdio never carries the RPC channel', () => {
    const plan = buildSpawnPlan(baseInput);
    expect(plan.options.cwd).toBe(`${baseInput.dir}/data`);
    expect(plan.options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });
});
