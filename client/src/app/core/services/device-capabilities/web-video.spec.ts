import { detectDolbyVisionProfiles, detectSampleEntries, detectWebVideo, webVideoMimes, type TypeProbe } from './web-video';

/** A probe that accepts a MIME when any listed fragment appears in it. */
const accepts = (...fragments: string[]): TypeProbe => (mime) => fragments.some((f) => mime.includes(f));

describe('detectWebVideo', () => {
  it('lists nothing for an engine that decodes nothing', () => {
    expect(detectWebVideo(() => false)).toEqual({ containers: [], videoCodecs: [], codecConditions: [] });
  });

  it('reports the codecs, the 10-bit flavours and the highest level the engine accepts', () => {
    const v = detectWebVideo(accepts('avc1', 'hvc1.1.6.L120', 'hvc1.1.6.L123', 'hvc1.1.6.L150', 'hvc1.2.4', 'av01.0.08M', 'vp09', 'vp8'));
    expect(v.containers).toEqual(['mp4', 'm4v', 'mov', 'webm']);
    expect(v.videoCodecs).toEqual(['h264', 'avc1', 'hevc', 'h265', 'hvc1', 'av1', 'vp9', 'vp8']);
    const cond = (c: string) => v.codecConditions.find((x) => x.codec === c);
    expect(cond('h264')).toMatchObject({ maxLevel: 62, maxBitDepth: 8 });
    expect(cond('hevc')).toMatchObject({ maxLevel: 150, maxBitDepth: 10, profiles: ['main', 'main 10'] });
    expect(cond('av1')).toMatchObject({ maxBitDepth: 10, profiles: ['main', 'high'] });
  });

  it('keeps HEVC and AV1 at 8 bit when the engine refuses their 10-bit strings', () => {
    const v = detectWebVideo(accepts('avc1', 'hvc1.1.6', 'av01.0.08M.08'));
    expect(v.codecConditions.find((c) => c.codec === 'hevc')).toMatchObject({ maxBitDepth: 8, profiles: ['main'] });
    expect(v.codecConditions.find((c) => c.codec === 'av1')).toMatchObject({ maxBitDepth: 8 });
  });

  it('stops probing levels at the first one refused', () => {
    const v = detectWebVideo((m) => /avc1\.(42E01E|42001E|42001F|640028)/.test(m) || m.includes('avc1.640034'));
    expect(v.codecConditions[0].maxLevel).toBe(40);
  });

  it('never lists MKV: no engine demuxes it', () => {
    expect(detectWebVideo(() => true).containers).not.toContain('mkv');
  });
});

describe('detectDolbyVisionProfiles', () => {
  it('names a profile when the engine claims either of its sample entries', () => {
    expect(detectDolbyVisionProfiles(accepts('dvh1.05', 'dvhe.08', 'dav1'))).toEqual([5, 8, 10]);
    expect(detectDolbyVisionProfiles(() => false)).toEqual([]);
  });
});

describe('detectSampleEntries', () => {
  it('asks the element only for the codecs the profile lists', () => {
    expect(detectSampleEntries(['h264'], () => true, false)).toEqual(['avc3']);
  });

  it('claims the entries canPlayType accepts', () => {
    expect(detectSampleEntries(['hevc'], accepts('dvh1'), false)).toEqual(['dvh1']);
  });

  it('claims every entry of a demuxer with no probe', () => {
    expect(detectSampleEntries(['hevc', 'av1'], () => false, true)).toEqual(['hev1', 'dvh1', 'dvhe', 'dav1']);
  });
});

describe('webVideoMimes', () => {
  it('lists every MIME the detectors may ask, once', () => {
    const mimes = webVideoMimes();
    expect(new Set(mimes).size).toBe(mimes.length);
    expect(mimes).toContain('video/mp4; codecs="hvc1.2.4.L120.B0"');
    expect(mimes).toContain('video/mp4; codecs="dvh1.05.06"');
  });
});
