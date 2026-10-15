import { readCmcd, readCmcdRaw } from './cmcd';

describe('readCmcd', () => {
  it('reads the CMCD query param', () => {
    expect(
      readCmcd({ query: { CMCD: 'bl=2100,br=3000,mtp=25400,su,sid="x",ot=v' } }),
    ).toEqual({ bl: 2100, br: 3000, mtp: 25400, ot: 'v' });
  });

  it('reads the CMCD-* headers', () => {
    expect(
      readCmcd({
        headers: {
          'cmcd-request': 'mtp=25400,bl=2100',
          'cmcd-object': 'br=3000,tb=8000',
          'cmcd-status': 'bs',
          'cmcd-session': 'sid="abc"',
        },
      }),
    ).toEqual({ mtp: 25400, bl: 2100, br: 3000 });
  });

  it('prefers the query over headers', () => {
    expect(
      readCmcd({ query: { CMCD: 'bl=1' }, headers: { 'cmcd-request': 'bl=9' } }),
    ).toEqual({ bl: 1 });
  });

  it('returns null without CMCD, with sid-only CMCD, or with garbage', () => {
    expect(readCmcd({ query: { sid: 'a' }, headers: {} })).toBeNull();
    expect(readCmcd({ query: { CMCD: 'sid="x"' } })).toBeNull();
    expect(readCmcd({ query: { CMCD: '%%%not sfv' } })).toBeNull();
    expect(readCmcd({ query: { CMCD: ['a', 'b'] } })).toBeNull();
  });

  it('drops negative and non-numeric values', () => {
    expect(readCmcd({ query: { CMCD: 'bl=-5,mtp="x",br=100' } })).toEqual({ br: 100 });
  });
});

describe('readCmcdRaw', () => {
  it('reads the query value as the engine reports it', () => {
    expect(readCmcdRaw('bl=2100,br=3000,mtp=25400,su,sid="x",ot=v')).toEqual({ bl: 2100, br: 3000, mtp: 25400, ot: 'v' });
  });

  it('reads the CMCD-* header values the engine joins with commas', () => {
    expect(readCmcdRaw('mtp=25400,bl=2100,br=3000,tb=8000,bs,sid="abc"')).toEqual({ mtp: 25400, bl: 2100, br: 3000 });
  });

  it('answers null for sid-only or garbage input', () => {
    expect(readCmcdRaw('sid="a"')).toBeNull();
    expect(readCmcdRaw('%%%=')).toBeNull();
  });
});
