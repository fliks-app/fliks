import { cpus } from 'os';
import { readFileSync } from 'fs';

/** cgroup v2 quota in whole (possibly fractional) cores from `cpu.max`
 *  (`"<quota> <period>"`, or `"max"` for unlimited). Null when unlimited,
 *  unreadable, or malformed. */
function cgroupV2Cores(): number | null {
  try {
    const [quotaStr, periodStr] = readFileSync('/sys/fs/cgroup/cpu.max', 'utf8')
      .trim()
      .split(/\s+/);
    if (quotaStr === 'max') return null;
    const quota = Number(quotaStr);
    const period = Number(periodStr);
    if (!Number.isFinite(quota) || quota <= 0 || !Number.isFinite(period) || period <= 0) {
      return null;
    }
    return quota / period;
  } catch {
    return null;
  }
}

/** cgroup v1 equivalent, split across `cpu.cfs_quota_us` / `cpu.cfs_period_us`.
 *  A quota of -1 means unlimited. */
function cgroupV1Cores(): number | null {
  try {
    const quota = Number(
      readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_quota_us', 'utf8').trim(),
    );
    const period = Number(
      readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_period_us', 'utf8').trim(),
    );
    if (!Number.isFinite(quota) || quota <= 0 || !Number.isFinite(period) || period <= 0) {
      return null;
    }
    return quota / period;
  } catch {
    return null;
  }
}

/** One process-wide budget for every background ffmpeg/fpcalc spawn, so a
 *  weak host can't end up running one decoder per subsystem at once.
 *  `os.cpus()` reports the host's core count even inside a container, so a
 *  compose `cpus:` quota is read from the cgroup directly and takes priority
 *  when it is the tighter constraint. */
function resolveSlots(): number {
  const override = Number(process.env.FLIKS_FFMPEG_SLOTS);
  if (Number.isInteger(override) && override > 0) return override;
  const hostCores = cpus().length;
  const quotaCores = cgroupV2Cores() ?? cgroupV1Cores();
  const cores = quotaCores != null ? Math.min(hostCores, quotaCores) : hostCores;
  return Math.max(1, Math.floor(cores) - 1);
}

export const FFMPEG_SLOTS = resolveSlots();

let active = 0;
const waiters: (() => void)[] = [];

function acquire(): Promise<void> {
  if (active < FFMPEG_SLOTS) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve));
}

/** Hands the freed slot straight to the oldest waiter (FIFO) instead of
 *  decrementing `active`, otherwise a fast new acquirer could cut the queue. */
function release(): void {
  const next = waiters.shift();
  if (next) next();
  else active--;
}

export async function withFfmpegSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}
