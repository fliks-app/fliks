import { cpus } from 'os';

/** One process-wide budget for every background ffmpeg/fpcalc spawn, so a
 *  weak host can't end up running one decoder per subsystem at once. */
function resolveSlots(): number {
  const override = Number(process.env.FLIKS_FFMPEG_SLOTS);
  if (Number.isInteger(override) && override > 0) return override;
  return Math.max(1, cpus().length - 1);
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
 *  decrementing `active` — otherwise a fast new acquirer could cut the queue. */
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
