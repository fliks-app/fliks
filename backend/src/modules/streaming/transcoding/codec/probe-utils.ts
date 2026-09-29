import * as os from 'os';
import * as path from 'path';
import { Logger } from '@nestjs/common';

/** Last two lines of a failed probe's ffmpeg stderr, for the boot log. */
export function ffmpegTail(err: unknown): string {
  const stderr = (err as { stderr?: string } | undefined)?.stderr?.trim();
  return stderr ? stderr.split('\n').slice(-2).join(' ') : '';
}

/** Tmp path for a boot-probe sample bitstream, unique per process so
 *  concurrent boots (tests, multiple instances) never collide. */
export function probeSamplePath(name: string, ext = 'hevc'): string {
  return path.join(os.tmpdir(), `fliks-${name}-probe-${process.pid}.${ext}`);
}

/** Single boot-time capability flag: fail-closed until `run` settles, then
 *  sticky. `run` never rejects, so one probe failing never stops the next. */
export interface CapabilityProbe {
  isEnabled(): boolean;
  run(log: Logger, attempt: () => Promise<void>): Promise<boolean>;
}

/** `attempt` runs once and reports its own argv/pre-steps; this owns the
 *  probed-once/enabled state, timing and the "enabled/disabled (Nms)" log. */
export function createCapabilityProbe(name: string): CapabilityProbe {
  let probedOnce = false;
  let enabled = false;
  return {
    isEnabled: () => probedOnce && enabled,
    async run(log, attempt) {
      const t0 = Date.now();
      let failure = '';
      try {
        await attempt();
        enabled = true;
      } catch (err) {
        enabled = false;
        failure = ffmpegTail(err);
      } finally {
        probedOnce = true;
        log.log(
          `[${name}] enabled=${enabled} (${Date.now() - t0}ms)${failure ? `: ${failure}` : ''}`,
        );
      }
      return enabled;
    },
  };
}
