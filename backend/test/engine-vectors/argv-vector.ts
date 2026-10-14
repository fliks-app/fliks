import { createHash } from 'crypto';
import type { Logger } from '@nestjs/common';
import {
  buildFfmpegArgs,
  buildRemuxArgs,
} from '../../src/modules/streaming/transcoding/ffmpeg-args';
import { buildIFrameSegmentArgs } from '../../src/modules/streaming/transcoding/iframe-trick-play';
import { buildLiveFfmpegArgs } from '../../src/modules/livetv/services/live-ffmpeg-args';
import { ALL_DESCRIPTORS } from '../../src/modules/streaming/transcoding/codec/encoders';
import {
  setSelectedRenderNode,
  vaapiRenderNode,
} from '../../src/modules/streaming/transcoding/hw-device';
import type { ArgvEnv, ArgvExpected, ArgvKind } from './argv-recorder';
import { withHostCaps, type HostCaps } from './host-caps';
import { sortKeys } from './vector';

export interface ArgvVector {
  name: string;
  source: string;
  kind: ArgvKind;
  hostCaps: HostCaps;
  env: ArgvEnv;
  input: unknown;
  expected?: ArgvExpected;
}

const silentLog = {
  debug: () => {},
  log: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

const BUILDERS: Record<ArgvKind, (input: never) => string[]> = {
  vod: (i) => buildFfmpegArgs(i, silentLog),
  remux: (i) => buildRemuxArgs(i, silentLog),
  live: (i) => buildLiveFfmpegArgs(i),
  iframe: (i) => buildIFrameSegmentArgs(i),
  encoder: (i: { id: string; input: never }) => {
    const d = ALL_DESCRIPTORS.find((x) => x.id === i.id);
    if (!d) throw new Error(`unknown encoder ${i.id}`);
    return d.buildArgs(i.input);
  },
};

/** Runs the builder on the stored input exactly as a fixture replays it. */
export function runArgvVector(v: ArgvVector): ArgvExpected {
  const prevNode = vaapiRenderNode();
  const prevOcl = process.env.FLIKS_OPENCL_DEVICE;
  const setOcl = (x: string | null | undefined) => {
    if (x == null) delete process.env.FLIKS_OPENCL_DEVICE;
    else process.env.FLIKS_OPENCL_DEVICE = x;
  };
  setSelectedRenderNode(v.env.renderNode);
  setOcl(v.env.openclDevice);
  try {
    return withHostCaps(v.hostCaps, () => {
      try {
        const input = JSON.parse(JSON.stringify(v.input)) as never;
        return { argv: [...BUILDERS[v.kind](input)] };
      } catch (e) {
        return { error: (e as Error).message };
      }
    });
  } finally {
    setSelectedRenderNode(prevNode);
    setOcl(prevOcl);
  }
}

export const argvHash = (v: ArgvVector): string =>
  createHash('sha1')
    .update(
      JSON.stringify(
        sortKeys({ k: v.kind, h: v.hostCaps, e: v.env, i: v.input }),
      ),
    )
    .digest('hex');

export const DEFAULT_ENV: ArgvEnv = {
  renderNode: '/dev/dri/renderD128',
  openclDevice: null,
};
