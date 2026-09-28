import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Synthesise a tiny HEVC Main10 PQ/BT.2020 HDR10 bitstream shared by the
 *  OpenCL/tonemap boot probes. Black frames are fine, only the filter-graph
 *  plumbing is under test. */
export async function synthesiseHdrProbeSample(outputPath: string): Promise<void> {
  await execFileAsync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'nullsrc=size=320x180:rate=30,format=yuv420p10le',
      '-frames:v',
      '8',
      '-c:v',
      'libx265',
      '-color_primaries',
      'bt2020',
      '-color_trc',
      'smpte2084',
      '-colorspace',
      'bt2020nc',
      '-x265-params',
      [
        'hdr-opt=1',
        'repeat-headers=1',
        'colorprim=bt2020',
        'transfer=smpte2084',
        'colormatrix=bt2020nc',
        'master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1)',
        'max-cll=1000,400',
      ].join(':'),
      outputPath,
    ],
    { timeout: 15_000 },
  );
}
