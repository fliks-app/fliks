import './probe-mocks';
import { Logger } from '@nestjs/common';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import {
  encodePipelineInputs,
  resolveEncodePipeline,
  resolveTonemapReport,
} from '../../src/modules/streaming/transcoding/encode-pipeline';
import { describeQoePipeline } from '../../src/modules/streaming/transcoding/qoe-pipeline';
import { sourceTimeline } from '../../src/modules/streaming/transcoding/source-timeline';
import { withHostCaps } from './host-caps';
import { runVector, sortKeys, type Vector } from './vector';

/**
 * Golden session-open report (`fixtures/report/open-report.json`): the playback clock offset, tone-map
 * step and curve and QoE pipeline playback-info derives for each `fixtures/decide` vector.
 *
 *   FLIKS_ENGINE_REPO=<engine>        rewrite the fixture from the engine's decide vectors
 *   FLIKS_ENGINE_REPO_CHECK=<engine>  recompute every case and compare
 */
Logger.overrideLogger(false);

const GEN = process.env.FLIKS_ENGINE_REPO;
const CHECK = process.env.FLIKS_ENGINE_REPO_CHECK;
const FILE = ['fixtures', 'report', 'open-report.json'];
// Cycled over the decide vectors so every curve is exercised.
const CURVES = ['mobius', 'hable', 'reinhard'] as const;
type Curve = (typeof CURVES)[number];

interface Decided {
  response: {
    playMethod: string;
    tonemapping?: boolean;
    quality?: string;
    audioCopyStream?: boolean;
    transcodeBitrateByQuality?: Record<string, { videoBitrateBps?: number }>;
  };
  videoVariant?: Parameters<typeof resolveEncodePipeline>[0];
}

function report(v: Vector, curve: Curve) {
  const config = { ...v.config, tonemapCurve: curve };
  const { response, videoVariant } = runVector({ ...v, config }) as Decided;
  const sel = v.input.selection;
  const burnIn =
    sel.burnInSubtitleId != null ? (sel.burnInIsText ? 'text' : 'image') : null;
  const v0 = v.input.info.video?.[0];
  return withHostCaps(v.hostCaps, () => {
    const inputs = encodePipelineInputs({
      hwAccel: v.hostCaps.hwAccel,
      crop: !!config.autoCropEnabled && v0?.crop != null,
      textBurnIn: burnIn === 'text',
      tonemap: !!response.tonemapping,
      tonemapAlgo: config.tonemapAlgo,
      sourceVideoCodec: (v0?.codec ?? '').toLowerCase() || undefined,
      isSourceHdr: !!v0?.hdrFormat,
      sourceDvProfile: v0?.dvProfile,
      sourceDvBlSignalCompatId: v0?.dvBlSignalCompatId,
    });
    const tonemap =
      response.tonemapping && videoVariant
        ? resolveTonemapReport(resolveEncodePipeline(videoVariant, inputs), {
            tonemap: true,
            dvNoBase: inputs.dvNoBase,
            dvApplyRpu: inputs.dvApplyRpu,
            burnIn: !!burnIn,
            sourceVideoCodec: inputs.sourceVideoCodec,
            hdr10Target: inputs.dvNoBase && videoVariant.hdr === 'HDR10',
            curve,
          })
        : null;
    const requested = sel.requestedQuality;
    const qoe = describeQoePipeline({
      playMethod: response.playMethod as never,
      source: {
        codec: inputs.sourceVideoCodec ?? null,
        width: v0?.width ?? null,
        height: v0?.height ?? null,
        hdr: v0?.dvProfile != null ? 'DV' : ((v0?.hdrFormat as never) ?? null),
      },
      variant:
        response.playMethod === 'Transcode' ? (videoVariant ?? null) : null,
      quality:
        response.quality && response.quality !== 'auto'
          ? response.quality
          : null,
      requested:
        typeof requested === 'string' && requested ? requested : 'auto',
      videoBitrateBps:
        response.transcodeBitrateByQuality?.[response.quality ?? '']
          ?.videoBitrateBps ?? null,
      inputs,
      tonemapPath: tonemap?.path ?? null,
      burnIn,
      crop: inputs.crop,
      audioTranscode: !response.audioCopyStream,
    });
    const t = sourceTimeline(v.input.info, v.input.media.path);
    return JSON.parse(
      JSON.stringify({
        playbackClockOffsetS:
          response.playMethod === 'DirectPlay' ? 0 : t.formatStart - t.origin,
        tonemapAlgo: tonemap?.path ?? null,
        tonemapCurve: tonemap?.curve ?? null,
        qoePipeline: qoe,
      }),
    ) as unknown;
  });
}

const decideDir = (repo: string) => join(repo, 'fixtures', 'decide');
const decideFiles = (repo: string) =>
  readdirSync(decideDir(repo))
    .filter((f) => f.endsWith('.json'))
    .sort();
const load = (repo: string, f: string) =>
  JSON.parse(readFileSync(join(decideDir(repo), f), 'utf8')) as Vector;
const isVector = (v: Vector) => !!(v.input && v.hostCaps && v.config);

if (GEN) {
  it('writes fixtures/report/open-report.json', () => {
    const cases: unknown[] = [];
    decideFiles(GEN).forEach((f, i) => {
      const v = load(GEN, f);
      if (!isVector(v)) return;
      const curve = CURVES[i % 3];
      cases.push({
        decide: f.replace(/\.json$/, ''),
        tonemapCurve: curve,
        expected: report(v, curve),
      });
    });
    mkdirSync(join(GEN, 'fixtures', 'report'), { recursive: true });
    writeFileSync(
      join(GEN, ...FILE),
      JSON.stringify({ name: 'open-report', source: 'ts', cases }, null, 1) +
        '\n',
    );
    expect(cases.length).toBeGreaterThan(0);
  });
} else if (CHECK) {
  const file = join(CHECK, ...FILE);
  const stored = existsSync(file)
    ? (
        JSON.parse(readFileSync(file, 'utf8')) as {
          cases: { decide: string; tonemapCurve: Curve; expected: unknown }[];
        }
      ).cases
    : [];
  describe('open report vectors match the engine checkout', () => {
    it('has fixtures', () => expect(stored.length).toBeGreaterThan(0));
    it.each(stored.map((c) => [c.decide, c] as const))('%s', (_n, c) => {
      expect(
        sortKeys(report(load(CHECK, `${c.decide}.json`), c.tonemapCurve)),
      ).toEqual(sortKeys(c.expected));
    });
  });
} else {
  it.skip('set FLIKS_ENGINE_REPO to generate, or FLIKS_ENGINE_REPO_CHECK to verify, the open report vectors', () =>
    undefined);
}
