import { Logger } from '@nestjs/common';
import { buildFfmpegArgs, buildRemuxArgs, videoMapSpec } from './ffmpeg-args';
import type { BuildFfmpegArgsOptions } from './ffmpeg-args';
import { buildImageBurnInFilterComplex } from './subtitle-overlay-filter';

/** A cover or thumbnail stream can sit at `0:v:0`; the programme is mapped by index. */
const silentLog = { debug: () => {}, log: () => {}, warn: () => {} } as unknown as Logger;

const maps = (args: string[]): string[] =>
  args.flatMap((a, i) => (a === '-map' ? [args[i + 1]] : []));

const tx = (over: Partial<BuildFfmpegArgsOptions>): string[] =>
  buildFfmpegArgs(
    {
      inputPath: '/media/in.mp4',
      outputDir: '/cache/out',
      hwAccel: 'none',
      profile: { name: '720p', maxWidth: 1280, maxHeight: 720, videoBitrate: '3M', audioBitrate: '128k' },
      videoVariant: { codec: 'h264', bitDepth: 8, hdr: null },
      sourceWidth: 1280,
      sourceHeight: 720,
      trustedStreamInfo: true,
      audioStreams: [{ streamIndex: 2 }],
      ...over,
    } as BuildFfmpegArgsOptions,
    silentLog,
  );

describe('programme video mapping', () => {
  it('maps the absolute index, else the first video', () => {
    expect(videoMapSpec(1)).toBe('0:1');
    expect(videoMapSpec(undefined)).toBe('0:v:0');
  });

  it('maps the programme in a transcode', () => {
    expect(maps(tx({ videoStreamIndex: 1 }))).toEqual(['0:1', '0:2']);
  });

  it('maps the programme and the picked track in a remux', () => {
    const args = buildRemuxArgs({
      inputPath: '/media/in.mp4',
      outputDir: '/cache/out',
      audioPlan: { mode: 'copy', codec: 'aac' },
      audioStreams: [{ streamIndex: 2 }, { streamIndex: 3 }],
      audioStreamIndex: 1,
      videoStreamIndex: 1,
    });
    expect(maps(args)).toEqual(['0:1', '0:3']);
  });

  it('overlays a bitmap subtitle on the programme, not the cover', () => {
    const graph = buildImageBurnInFilterComplex({
      hwAccel: 'none',
      videoFilter: 'scale=1280:720',
      streamIndex: 3,
      videoStreamIndex: 1,
      width: 1280,
      height: 720,
      bitDepth: 8,
    });
    expect(graph.startsWith('[0:1]scale=1280:720')).toBe(true);
    expect(graph).not.toContain('[0:v]');
  });
});
