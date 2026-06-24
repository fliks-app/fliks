import { cmafRewrite, isCmafRewritten } from './cmaf-rewrite';

/** Build a minimal ISO-BMFF box: [size(4)][type(4)][payload]. */
function box(type: string, payload: Buffer = Buffer.alloc(0)): Buffer {
  const b = Buffer.alloc(8 + payload.length);
  b.writeUInt32BE(8 + payload.length, 0);
  b.write(type, 4, 'latin1');
  payload.copy(b, 8);
  return b;
}

/** ftyp payload: major brand + minor version + compat-brand list. */
function ftyp(major: string, compat: string[]): Buffer {
  return box(
    'ftyp',
    Buffer.concat([
      Buffer.from(major, 'latin1'),
      Buffer.from([0, 0, 0, 0]),
      ...compat.map((b) => Buffer.from(b, 'latin1')),
    ]),
  );
}

describe('cmafRewrite', () => {
  it('appends hlsf to the ftyp compat list, grows the box by 4, keeps the major brand', () => {
    const init = ftyp('iso5', ['iso5', 'iso6', 'mp41']);
    const moov = box('moov', Buffer.from('payload'));
    const out = cmafRewrite(Buffer.concat([init, moov]));

    expect(out.includes(Buffer.from('hlsf', 'latin1'))).toBe(true);
    expect(out.readUInt32BE(0)).toBe(init.readUInt32BE(0) + 4); // +4 for the brand
    expect(out.slice(8, 12).toString('latin1')).toBe('iso5'); // major brand intact
    // moov rides unchanged right after the grown ftyp.
    expect(out.slice(out.readUInt32BE(0)).equals(moov)).toBe(true);
  });

  it('strips styp and sidx from a media segment, keeping moof + mdat', () => {
    const styp = box('styp', Buffer.from('msdhmsix'));
    const sidx = box('sidx', Buffer.from('idxdata'));
    const moof = box('moof', Buffer.from('moofdata'));
    const mdat = box('mdat', Buffer.from('framedata'));
    const out = cmafRewrite(Buffer.concat([styp, sidx, moof, mdat]));

    expect(out.equals(Buffer.concat([moof, mdat]))).toBe(true);
  });

  it('is idempotent — a second pass leaves an already-rewritten buffer unchanged', () => {
    const once = cmafRewrite(
      Buffer.concat([ftyp('iso5', ['iso5']), box('moov')]),
    );
    expect(isCmafRewritten(once)).toBe(true);
    expect(cmafRewrite(once).equals(once)).toBe(true);
  });

  it('copies a truncated trailing box verbatim instead of throwing', () => {
    const moof = box('moof', Buffer.from('ok'));
    const truncated = Buffer.alloc(12);
    truncated.writeUInt32BE(999, 0); // claims 999 bytes but only 12 present
    truncated.write('mdat', 4, 'latin1');
    const input = Buffer.concat([moof, truncated]);
    expect(() => cmafRewrite(input)).not.toThrow();
    expect(cmafRewrite(input).equals(input)).toBe(true);
  });
});

describe('isCmafRewritten', () => {
  it('is false for raw FFmpeg output (leading styp, no hlsf)', () => {
    expect(isCmafRewritten(Buffer.concat([box('styp'), box('moof')]))).toBe(false);
    expect(isCmafRewritten(ftyp('iso5', ['iso5', 'iso6']))).toBe(false);
  });

  it('is true once the ftyp carries hlsf or a segment leads with moof', () => {
    expect(isCmafRewritten(ftyp('iso5', ['iso5', 'hlsf']))).toBe(true);
    expect(isCmafRewritten(box('moof', Buffer.from('frame')))).toBe(true);
  });
});
