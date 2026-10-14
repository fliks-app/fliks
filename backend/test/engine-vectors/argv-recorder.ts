import { vaapiRenderNode } from '../../src/modules/streaming/transcoding/hw-device';
import { currentCaps, type HostCaps } from './host-caps';

export type ArgvKind = 'vod' | 'remux' | 'encoder' | 'live' | 'iframe';

export interface ArgvEnv {
  renderNode: string;
  openclDevice: string | null;
}

export type ArgvExpected = { argv: string[] } | { error: string };

export interface RecordedCall {
  name: string;
  source: string;
  kind: ArgvKind;
  hostCaps: HostCaps;
  env: ArgvEnv;
  input: unknown;
  /** What the call returned in the spec, to check the stored input reproduces it. */
  result: ArgvExpected;
}

/** Shared by the jest.mock factories, so it imports nothing that is mocked. */
export const recorder = {
  on: false,
  encoders: false,
  depth: 0,
  spec: '',
  calls: [] as RecordedCall[],
};

export function captureHost(): { hostCaps: HostCaps; env: ArgvEnv } {
  return {
    hostCaps: {
      ...currentCaps(),
      platform: process.platform as HostCaps['platform'],
    },
    env: {
      renderNode: vaapiRenderNode(),
      openclDevice: process.env.FLIKS_OPENCL_DEVICE ?? null,
    },
  };
}

const clone = (x: unknown): unknown => JSON.parse(JSON.stringify(x ?? null));

/** Wraps a builder so a top-level call made while recording is captured. */
export function mockRecord<A extends unknown[]>(
  kind: ArgvKind,
  fn: (...a: A) => string[],
  inputOf: (...a: A) => unknown = (...a) => a[0],
  when: () => boolean = () => true,
): (...a: A) => string[] {
  return (...a: A) => {
    const rec = recorder.on && recorder.depth === 0 && when();
    const input = rec ? clone(inputOf(...a)) : undefined;
    const host = rec ? captureHost() : undefined;
    recorder.depth++;
    let result: ArgvExpected;
    try {
      const argv = fn(...a);
      result = { argv: [...argv] };
      return argv;
    } catch (e) {
      result = { error: (e as Error).message };
      throw e;
    } finally {
      recorder.depth--;
      if (rec)
        recorder.calls.push({
          name: expect.getState().currentTestName ?? 'case',
          source: recorder.spec,
          kind,
          ...host!,
          input,
          result: result!,
        });
    }
  };
}
