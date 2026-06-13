import { generateMasterPlaylist } from './master-playlist';
import type { CodecVariant } from './codec/types';
import type { AudioStreamMeta } from './types';

/**
 * Characterization (golden) snapshots of the HLS master playlist across the
 * codec / HDR / audio-layout matrix. These lock the exact manifest the current
 * code emits so the upcoming variant-driven HlsManifestWriter refactor (and any
 * ladder/codec-string change) can't silently alter the wire contract —
 * a manifest that contradicts the segments is the root of the recurring MSE
 * chunk-demuxer rejects (Shaka 3014/4032). If a snapshot changes, the diff is
 * the exact manifest delta to review, not a mystery playback regression.
 *
 * Fixed, source-cap-neutral inputs (100 Mbps source) so only the ladder and the
 * HEVC Main-tier clamp shape the numbers.
 */

const SRC_BITRATE = 100_000_000;

const HEVC_SDR: CodecVariant = { codec: 'hevc', bitDepth: 8, hdr: null };
const AV1_SDR: CodecVariant = { codec: 'av1', bitDepth: 8, hdr: null };
const HEVC_HDR10: CodecVariant = { codec: 'hevc', bitDepth: 10, hdr: 'HDR10' };
const AV1_HDR10: CodecVariant = { codec: 'av1', bitDepth: 10, hdr: 'HDR10' };

interface MasterOpts {
  width?: number;
  height?: number;
  audioStreams?: AudioStreamMeta[];
  deviceType?: 'mobile' | 'desktop';
  outputAudioCodec?: string;
  hdrVariant?: CodecVariant;
  hdrFormat?: 'HDR10' | 'HLG';
  sdrVariant?: CodecVariant;
  sourceFrameRate?: number;
  sourceVideoCodec?: string;
}

function master(opts: MasterOpts = {}): string {
  const {
    width = 1920,
    height = 1080,
    audioStreams,
    deviceType = 'desktop',
    outputAudioCodec = 'aac',
    hdrVariant,
    hdrFormat = 'HDR10',
    sdrVariant,
    sourceFrameRate = 24,
    sourceVideoCodec = 'hevc',
  } = opts;
  return generateMasterPlaylist(
    7, // mediaFileId
    width,
    height,
    '', // tokenParam
    false, // includeRemux
    undefined, // sourceBitrate
    audioStreams,
    undefined, // onlyQuality
    0, // defaultAudioIndex
    deviceType,
    outputAudioCodec,
    hdrVariant ? { hdrFormat, hdrVariant } : undefined,
    !!hdrVariant, // canEmitHdrLadder
    sdrVariant,
    sourceFrameRate,
    undefined, // subtitleRenditions
    SRC_BITRATE,
    sourceVideoCodec,
  );
}

describe('generateMasterPlaylist — golden manifests (characterization)', () => {
  it('SDR H.264 ladder, single muxed audio (1080p)', () => {
    expect(master({ sourceVideoCodec: 'h264' })).toMatchInlineSnapshot(`
     "#EXTM3U
     #EXT-X-VERSION:7
     #EXT-X-INDEPENDENT-SEGMENTS
     #EXT-X-STREAM-INF:BANDWIDTH=12288000,AVERAGE-BANDWIDTH=8192000,RESOLUTION=1920x1080,FRAME-RATE=24,NAME="1080p",CODECS="avc1.640028,mp4a.40.2"
     /api/stream/7/1080p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=6192000,AVERAGE-BANDWIDTH=4128000,RESOLUTION=1280x720,FRAME-RATE=24,NAME="720p",CODECS="avc1.64001f,mp4a.40.2"
     /api/stream/7/720p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=3144000,AVERAGE-BANDWIDTH=2096000,RESOLUTION=854x482,FRAME-RATE=24,NAME="480p",CODECS="avc1.64001f,mp4a.40.2"
     /api/stream/7/480p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=1596000,AVERAGE-BANDWIDTH=1064000,RESOLUTION=640x360,FRAME-RATE=24,NAME="360p",CODECS="avc1.64001e,mp4a.40.2"
     /api/stream/7/360p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=846000,AVERAGE-BANDWIDTH=564000,RESOLUTION=426x240,FRAME-RATE=24,NAME="240p",CODECS="avc1.640015,mp4a.40.2"
     /api/stream/7/240p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=372000,AVERAGE-BANDWIDTH=248000,RESOLUTION=256x144,FRAME-RATE=24,NAME="144p",CODECS="avc1.64000d,mp4a.40.2"
     /api/stream/7/144p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=4788000,AVERAGE-BANDWIDTH=3192000,RESOLUTION=1920x1080,FRAME-RATE=24,NAME="eco-1080p",CODECS="avc1.640028,mp4a.40.2"
     /api/stream/7/eco-1080p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=2442000,AVERAGE-BANDWIDTH=1628000,RESOLUTION=1280x720,FRAME-RATE=24,NAME="eco-720p",CODECS="avc1.64001f,mp4a.40.2"
     /api/stream/7/eco-720p/index.m3u8"
    `);
  });

  it('SDR HEVC ladder (1080p)', () => {
    expect(master({ sdrVariant: HEVC_SDR })).toMatchInlineSnapshot(`
     "#EXTM3U
     #EXT-X-VERSION:7
     #EXT-X-INDEPENDENT-SEGMENTS
     #EXT-X-STREAM-INF:BANDWIDTH=12288000,AVERAGE-BANDWIDTH=8192000,RESOLUTION=1920x1080,FRAME-RATE=24,NAME="1080p",CODECS="hvc1.1.6.L120.B0,mp4a.40.2"
     /api/stream/7/1080p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=6192000,AVERAGE-BANDWIDTH=4128000,RESOLUTION=1280x720,FRAME-RATE=24,NAME="720p",CODECS="hvc1.1.6.L93.B0,mp4a.40.2"
     /api/stream/7/720p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=3144000,AVERAGE-BANDWIDTH=2096000,RESOLUTION=854x482,FRAME-RATE=24,NAME="480p",CODECS="hvc1.1.6.L93.B0,mp4a.40.2"
     /api/stream/7/480p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=1596000,AVERAGE-BANDWIDTH=1064000,RESOLUTION=640x360,FRAME-RATE=24,NAME="360p",CODECS="hvc1.1.6.L93.B0,mp4a.40.2"
     /api/stream/7/360p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=846000,AVERAGE-BANDWIDTH=564000,RESOLUTION=426x240,FRAME-RATE=24,NAME="240p",CODECS="hvc1.1.6.L93.B0,mp4a.40.2"
     /api/stream/7/240p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=372000,AVERAGE-BANDWIDTH=248000,RESOLUTION=256x144,FRAME-RATE=24,NAME="144p",CODECS="hvc1.1.6.L93.B0,mp4a.40.2"
     /api/stream/7/144p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=4788000,AVERAGE-BANDWIDTH=3192000,RESOLUTION=1920x1080,FRAME-RATE=24,NAME="eco-1080p",CODECS="hvc1.1.6.L120.B0,mp4a.40.2"
     /api/stream/7/eco-1080p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=2442000,AVERAGE-BANDWIDTH=1628000,RESOLUTION=1280x720,FRAME-RATE=24,NAME="eco-720p",CODECS="hvc1.1.6.L93.B0,mp4a.40.2"
     /api/stream/7/eco-720p/index.m3u8"
    `);
  });

  it('SDR AV1 ladder (1080p)', () => {
    expect(master({ sdrVariant: AV1_SDR })).toMatchInlineSnapshot(`
     "#EXTM3U
     #EXT-X-VERSION:7
     #EXT-X-INDEPENDENT-SEGMENTS
     #EXT-X-STREAM-INF:BANDWIDTH=12288000,AVERAGE-BANDWIDTH=8192000,RESOLUTION=1920x1080,FRAME-RATE=24,NAME="1080p",CODECS="av01.0.04M.08,mp4a.40.2"
     /api/stream/7/1080p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=6192000,AVERAGE-BANDWIDTH=4128000,RESOLUTION=1280x720,FRAME-RATE=24,NAME="720p",CODECS="av01.0.04M.08,mp4a.40.2"
     /api/stream/7/720p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=3144000,AVERAGE-BANDWIDTH=2096000,RESOLUTION=854x482,FRAME-RATE=24,NAME="480p",CODECS="av01.0.04M.08,mp4a.40.2"
     /api/stream/7/480p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=1596000,AVERAGE-BANDWIDTH=1064000,RESOLUTION=640x360,FRAME-RATE=24,NAME="360p",CODECS="av01.0.04M.08,mp4a.40.2"
     /api/stream/7/360p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=846000,AVERAGE-BANDWIDTH=564000,RESOLUTION=426x240,FRAME-RATE=24,NAME="240p",CODECS="av01.0.04M.08,mp4a.40.2"
     /api/stream/7/240p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=372000,AVERAGE-BANDWIDTH=248000,RESOLUTION=256x144,FRAME-RATE=24,NAME="144p",CODECS="av01.0.04M.08,mp4a.40.2"
     /api/stream/7/144p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=4788000,AVERAGE-BANDWIDTH=3192000,RESOLUTION=1920x1080,FRAME-RATE=24,NAME="eco-1080p",CODECS="av01.0.04M.08,mp4a.40.2"
     /api/stream/7/eco-1080p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=2442000,AVERAGE-BANDWIDTH=1628000,RESOLUTION=1280x720,FRAME-RATE=24,NAME="eco-720p",CODECS="av01.0.04M.08,mp4a.40.2"
     /api/stream/7/eco-720p/index.m3u8"
    `);
  });

  it('HDR HEVC ladder (4K) — Main-tier-clamped bandwidth', () => {
    expect(master({ width: 3840, height: 2160, hdrVariant: HEVC_HDR10 }))
      .toMatchInlineSnapshot(`
     "#EXTM3U
     #EXT-X-VERSION:7
     #EXT-X-INDEPENDENT-SEGMENTS
     #EXT-X-STREAM-INF:BANDWIDTH=37788000,AVERAGE-BANDWIDTH=25192000,RESOLUTION=3840x2160,VIDEO-RANGE=PQ,FRAME-RATE=24,NAME="2160p-hdr",CODECS="hvc1.2.4.L150.B0,mp4a.40.2"
     /api/stream/7/2160p-hdr/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=8538000,AVERAGE-BANDWIDTH=5692000,RESOLUTION=1920x1080,VIDEO-RANGE=PQ,FRAME-RATE=24,NAME="1080p-hdr",CODECS="hvc1.2.4.L120.B0,mp4a.40.2"
     /api/stream/7/1080p-hdr/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=4392000,AVERAGE-BANDWIDTH=2928000,RESOLUTION=1280x720,VIDEO-RANGE=PQ,FRAME-RATE=24,NAME="720p-hdr",CODECS="hvc1.2.4.L93.B0,mp4a.40.2"
     /api/stream/7/720p-hdr/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=2244000,AVERAGE-BANDWIDTH=1496000,RESOLUTION=854x482,VIDEO-RANGE=PQ,FRAME-RATE=24,NAME="480p-hdr",CODECS="hvc1.2.4.L93.B0,mp4a.40.2"
     /api/stream/7/480p-hdr/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=18288000,AVERAGE-BANDWIDTH=12192000,RESOLUTION=3840x2160,VIDEO-RANGE=PQ,FRAME-RATE=24,NAME="eco-2160p-hdr",CODECS="hvc1.2.4.L150.B0,mp4a.40.2"
     /api/stream/7/eco-2160p-hdr/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=3588000,AVERAGE-BANDWIDTH=2392000,RESOLUTION=1920x1080,VIDEO-RANGE=PQ,FRAME-RATE=24,NAME="eco-1080p-hdr",CODECS="hvc1.2.4.L120.B0,mp4a.40.2"
     /api/stream/7/eco-1080p-hdr/index.m3u8"
    `);
  });

  it('HDR AV1 ladder (4K)', () => {
    expect(master({ width: 3840, height: 2160, hdrVariant: AV1_HDR10 }))
      .toMatchInlineSnapshot(`
     "#EXTM3U
     #EXT-X-VERSION:7
     #EXT-X-INDEPENDENT-SEGMENTS
     #EXT-X-STREAM-INF:BANDWIDTH=42288000,AVERAGE-BANDWIDTH=28192000,RESOLUTION=3840x2160,VIDEO-RANGE=PQ,FRAME-RATE=24,NAME="2160p-hdr",CODECS="av01.0.08M.10,mp4a.40.2"
     /api/stream/7/2160p-hdr/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=8538000,AVERAGE-BANDWIDTH=5692000,RESOLUTION=1920x1080,VIDEO-RANGE=PQ,FRAME-RATE=24,NAME="1080p-hdr",CODECS="av01.0.04M.10,mp4a.40.2"
     /api/stream/7/1080p-hdr/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=4392000,AVERAGE-BANDWIDTH=2928000,RESOLUTION=1280x720,VIDEO-RANGE=PQ,FRAME-RATE=24,NAME="720p-hdr",CODECS="av01.0.04M.10,mp4a.40.2"
     /api/stream/7/720p-hdr/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=2244000,AVERAGE-BANDWIDTH=1496000,RESOLUTION=854x482,VIDEO-RANGE=PQ,FRAME-RATE=24,NAME="480p-hdr",CODECS="av01.0.04M.10,mp4a.40.2"
     /api/stream/7/480p-hdr/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=18288000,AVERAGE-BANDWIDTH=12192000,RESOLUTION=3840x2160,VIDEO-RANGE=PQ,FRAME-RATE=24,NAME="eco-2160p-hdr",CODECS="av01.0.08M.10,mp4a.40.2"
     /api/stream/7/eco-2160p-hdr/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=3588000,AVERAGE-BANDWIDTH=2392000,RESOLUTION=1920x1080,VIDEO-RANGE=PQ,FRAME-RATE=24,NAME="eco-1080p-hdr",CODECS="av01.0.04M.10,mp4a.40.2"
     /api/stream/7/eco-1080p-hdr/index.m3u8"
    `);
  });

  it('HLG HEVC ladder (4K)', () => {
    expect(
      master({
        width: 3840,
        height: 2160,
        hdrVariant: { codec: 'hevc', bitDepth: 10, hdr: 'HLG' },
        hdrFormat: 'HLG',
      }),
    ).toMatchInlineSnapshot(`
     "#EXTM3U
     #EXT-X-VERSION:7
     #EXT-X-INDEPENDENT-SEGMENTS
     #EXT-X-STREAM-INF:BANDWIDTH=37788000,AVERAGE-BANDWIDTH=25192000,RESOLUTION=3840x2160,VIDEO-RANGE=HLG,FRAME-RATE=24,NAME="2160p-hdr",CODECS="hvc1.2.4.L150.B0,mp4a.40.2"
     /api/stream/7/2160p-hdr/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=8538000,AVERAGE-BANDWIDTH=5692000,RESOLUTION=1920x1080,VIDEO-RANGE=HLG,FRAME-RATE=24,NAME="1080p-hdr",CODECS="hvc1.2.4.L120.B0,mp4a.40.2"
     /api/stream/7/1080p-hdr/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=4392000,AVERAGE-BANDWIDTH=2928000,RESOLUTION=1280x720,VIDEO-RANGE=HLG,FRAME-RATE=24,NAME="720p-hdr",CODECS="hvc1.2.4.L93.B0,mp4a.40.2"
     /api/stream/7/720p-hdr/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=2244000,AVERAGE-BANDWIDTH=1496000,RESOLUTION=854x482,VIDEO-RANGE=HLG,FRAME-RATE=24,NAME="480p-hdr",CODECS="hvc1.2.4.L93.B0,mp4a.40.2"
     /api/stream/7/480p-hdr/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=18288000,AVERAGE-BANDWIDTH=12192000,RESOLUTION=3840x2160,VIDEO-RANGE=HLG,FRAME-RATE=24,NAME="eco-2160p-hdr",CODECS="hvc1.2.4.L150.B0,mp4a.40.2"
     /api/stream/7/eco-2160p-hdr/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=3588000,AVERAGE-BANDWIDTH=2392000,RESOLUTION=1920x1080,VIDEO-RANGE=HLG,FRAME-RATE=24,NAME="eco-1080p-hdr",CODECS="hvc1.2.4.L120.B0,mp4a.40.2"
     /api/stream/7/eco-1080p-hdr/index.m3u8"
    `);
  });

  it('multi-audio EXT-X-MEDIA layout (2 E-AC-3 tracks, var-stream-map)', () => {
    expect(
      master({
        sdrVariant: HEVC_SDR,
        outputAudioCodec: 'eac3',
        audioStreams: [
          { language: 'eng', title: 'English', channels: 6 },
          { language: 'fre', title: 'VF', channels: 6 },
        ],
      }),
    ).toMatchInlineSnapshot(`
     "#EXTM3U
     #EXT-X-VERSION:7
     #EXT-X-INDEPENDENT-SEGMENTS
     #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="eng",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="6",URI="/api/stream/7/audio/0/index.m3u8"
     #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="VF",LANGUAGE="fre",DEFAULT=NO,AUTOSELECT=NO,CHANNELS="6",URI="/api/stream/7/audio/1/index.m3u8"
     #EXT-X-STREAM-INF:BANDWIDTH=12288000,AVERAGE-BANDWIDTH=8192000,RESOLUTION=1920x1080,FRAME-RATE=24,NAME="1080p",CODECS="hvc1.1.6.L120.B0,ec-3",AUDIO="audio"
     /api/stream/7/1080p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=6192000,AVERAGE-BANDWIDTH=4128000,RESOLUTION=1280x720,FRAME-RATE=24,NAME="720p",CODECS="hvc1.1.6.L93.B0,ec-3",AUDIO="audio"
     /api/stream/7/720p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=3144000,AVERAGE-BANDWIDTH=2096000,RESOLUTION=854x482,FRAME-RATE=24,NAME="480p",CODECS="hvc1.1.6.L93.B0,ec-3",AUDIO="audio"
     /api/stream/7/480p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=1596000,AVERAGE-BANDWIDTH=1064000,RESOLUTION=640x360,FRAME-RATE=24,NAME="360p",CODECS="hvc1.1.6.L93.B0,ec-3",AUDIO="audio"
     /api/stream/7/360p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=846000,AVERAGE-BANDWIDTH=564000,RESOLUTION=426x240,FRAME-RATE=24,NAME="240p",CODECS="hvc1.1.6.L93.B0,ec-3",AUDIO="audio"
     /api/stream/7/240p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=372000,AVERAGE-BANDWIDTH=248000,RESOLUTION=256x144,FRAME-RATE=24,NAME="144p",CODECS="hvc1.1.6.L93.B0,ec-3",AUDIO="audio"
     /api/stream/7/144p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=4788000,AVERAGE-BANDWIDTH=3192000,RESOLUTION=1920x1080,FRAME-RATE=24,NAME="eco-1080p",CODECS="hvc1.1.6.L120.B0,ec-3",AUDIO="audio"
     /api/stream/7/eco-1080p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=2442000,AVERAGE-BANDWIDTH=1628000,RESOLUTION=1280x720,FRAME-RATE=24,NAME="eco-720p",CODECS="hvc1.1.6.L93.B0,ec-3",AUDIO="audio"
     /api/stream/7/eco-720p/index.m3u8"
    `);
  });

  it('audio-less source drops the audio entry from CODECS', () => {
    expect(master({ audioStreams: [] })).toMatchInlineSnapshot(`
     "#EXTM3U
     #EXT-X-VERSION:7
     #EXT-X-INDEPENDENT-SEGMENTS
     #EXT-X-STREAM-INF:BANDWIDTH=12288000,AVERAGE-BANDWIDTH=8192000,RESOLUTION=1920x1080,FRAME-RATE=24,NAME="1080p",CODECS="avc1.640028"
     /api/stream/7/1080p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=6192000,AVERAGE-BANDWIDTH=4128000,RESOLUTION=1280x720,FRAME-RATE=24,NAME="720p",CODECS="avc1.64001f"
     /api/stream/7/720p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=3144000,AVERAGE-BANDWIDTH=2096000,RESOLUTION=854x482,FRAME-RATE=24,NAME="480p",CODECS="avc1.64001f"
     /api/stream/7/480p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=1596000,AVERAGE-BANDWIDTH=1064000,RESOLUTION=640x360,FRAME-RATE=24,NAME="360p",CODECS="avc1.64001e"
     /api/stream/7/360p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=846000,AVERAGE-BANDWIDTH=564000,RESOLUTION=426x240,FRAME-RATE=24,NAME="240p",CODECS="avc1.640015"
     /api/stream/7/240p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=372000,AVERAGE-BANDWIDTH=248000,RESOLUTION=256x144,FRAME-RATE=24,NAME="144p",CODECS="avc1.64000d"
     /api/stream/7/144p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=4788000,AVERAGE-BANDWIDTH=3192000,RESOLUTION=1920x1080,FRAME-RATE=24,NAME="eco-1080p",CODECS="avc1.640028"
     /api/stream/7/eco-1080p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=2442000,AVERAGE-BANDWIDTH=1628000,RESOLUTION=1280x720,FRAME-RATE=24,NAME="eco-720p",CODECS="avc1.64001f"
     /api/stream/7/eco-720p/index.m3u8"
    `);
  });

  it('mobile device ladder', () => {
    expect(master({ deviceType: 'mobile' })).toMatchInlineSnapshot(`
     "#EXTM3U
     #EXT-X-VERSION:7
     #EXT-X-INDEPENDENT-SEGMENTS
     #EXT-X-STREAM-INF:BANDWIDTH=12288000,AVERAGE-BANDWIDTH=8192000,RESOLUTION=1920x1080,FRAME-RATE=24,NAME="1080p",CODECS="avc1.640028,mp4a.40.2"
     /api/stream/7/1080p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=6192000,AVERAGE-BANDWIDTH=4128000,RESOLUTION=1280x720,FRAME-RATE=24,NAME="720p",CODECS="avc1.64001f,mp4a.40.2"
     /api/stream/7/720p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=3144000,AVERAGE-BANDWIDTH=2096000,RESOLUTION=854x482,FRAME-RATE=24,NAME="480p",CODECS="avc1.64001f,mp4a.40.2"
     /api/stream/7/480p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=1596000,AVERAGE-BANDWIDTH=1064000,RESOLUTION=640x360,FRAME-RATE=24,NAME="360p",CODECS="avc1.64001e,mp4a.40.2"
     /api/stream/7/360p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=846000,AVERAGE-BANDWIDTH=564000,RESOLUTION=426x240,FRAME-RATE=24,NAME="240p",CODECS="avc1.640015,mp4a.40.2"
     /api/stream/7/240p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=372000,AVERAGE-BANDWIDTH=248000,RESOLUTION=256x144,FRAME-RATE=24,NAME="144p",CODECS="avc1.64000d,mp4a.40.2"
     /api/stream/7/144p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=4788000,AVERAGE-BANDWIDTH=3192000,RESOLUTION=1920x1080,FRAME-RATE=24,NAME="eco-1080p",CODECS="avc1.640028,mp4a.40.2"
     /api/stream/7/eco-1080p/index.m3u8
     #EXT-X-STREAM-INF:BANDWIDTH=2442000,AVERAGE-BANDWIDTH=1628000,RESOLUTION=1280x720,FRAME-RATE=24,NAME="eco-720p",CODECS="avc1.64001f,mp4a.40.2"
     /api/stream/7/eco-720p/index.m3u8"
    `);
  });
});
