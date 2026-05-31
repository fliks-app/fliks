import { parseHdrStaticMetadata } from './ffprobe.service';

const MASTERING_RATIONAL = {
  side_data_type: 'Mastering display metadata',
  red_x: '34000/50000',
  red_y: '16000/50000',
  green_x: '13250/50000',
  green_y: '34500/50000',
  blue_x: '7500/50000',
  blue_y: '3000/50000',
  white_point_x: '15635/50000',
  white_point_y: '16450/50000',
  min_luminance: '50/10000',
  max_luminance: '10000000/10000',
};
const CONTENT_LIGHT = {
  side_data_type: 'Content light level metadata',
  max_content: 1000,
  max_average: 400,
};
// Coordinates scale by 50000, luminance by 10000 (0.0001 cd/m²).
const EXPECTED_DISPLAY =
  'G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50)';

describe('parseHdrStaticMetadata', () => {
  it('parses full HDR10 side-data (rational form)', () => {
    expect(parseHdrStaticMetadata([MASTERING_RATIONAL, CONTENT_LIGHT])).toEqual(
      { masteringDisplay: EXPECTED_DISPLAY, maxCll: 1000, maxFall: 400 },
    );
  });

  it('parses the same values in decimal form (older ffprobe)', () => {
    const decimal = {
      side_data_type: 'Mastering display metadata',
      red_x: 0.68,
      red_y: 0.32,
      green_x: 0.265,
      green_y: 0.69,
      blue_x: 0.15,
      blue_y: 0.06,
      white_point_x: 0.3127,
      white_point_y: 0.329,
      min_luminance: 0.005,
      max_luminance: 1000,
    };
    expect(parseHdrStaticMetadata([decimal, CONTENT_LIGHT])).toEqual({
      masteringDisplay: EXPECTED_DISPLAY,
      maxCll: 1000,
      maxFall: 400,
    });
  });

  it('returns maxCll/maxFall 0 when content-light side-data is absent', () => {
    expect(parseHdrStaticMetadata([MASTERING_RATIONAL])).toEqual({
      masteringDisplay: EXPECTED_DISPLAY,
      maxCll: 0,
      maxFall: 0,
    });
  });

  it('returns null when there is no mastering-display side-data (HLG / SDR)', () => {
    expect(parseHdrStaticMetadata([CONTENT_LIGHT])).toBeNull();
    expect(parseHdrStaticMetadata([])).toBeNull();
    expect(parseHdrStaticMetadata(undefined)).toBeNull();
  });

  it('returns null when the mastering-display block is incomplete', () => {
    const partial = { ...MASTERING_RATIONAL };
    delete (partial as Record<string, unknown>).max_luminance;
    expect(parseHdrStaticMetadata([partial])).toBeNull();
  });
});
