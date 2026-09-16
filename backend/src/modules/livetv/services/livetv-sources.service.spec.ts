import { BadRequestException } from '@nestjs/common';
import {
  classifyEntries,
  compileGroupPattern,
  tryCompilePattern,
} from './livetv-sources.service';

function entry(overrides: Partial<Parameters<typeof classifyEntries>[0][number]> = {}) {
  return {
    externalId: '1',
    name: 'A',
    url: 'http://h/live/1.ts',
    logo: null,
    groupName: 'News',
    tvgId: null,
    number: null,
    qualityLabel: null,
    shiftMinutes: 0,
    userAgent: null,
    referer: null,
    ...overrides,
  };
}

describe('classifyEntries', () => {
  it('drops on-demand entries and counts them separately from live ones', () => {
    const result = classifyEntries(
      [
        entry({ externalId: '1', url: 'http://h/live/1.ts' }),
        entry({ externalId: '2', url: 'http://h/movie/2.mp4' }),
        entry({ externalId: '3', url: 'http://h/series/1/2/3.mp4' }),
      ],
      null,
      null,
    );
    expect(result.live.map((e) => e.externalId)).toEqual(['1']);
    expect(result.onDemandCount).toBe(2);
  });

  it('tallies group-title counts among live entries only, pre-regex', () => {
    const result = classifyEntries(
      [
        entry({ externalId: '1', groupName: 'News' }),
        entry({ externalId: '2', groupName: 'News' }),
        entry({ externalId: '3', groupName: 'Sport' }),
        entry({ externalId: '4', url: 'http://h/movie/4.mp4', groupName: 'VOD Action' }),
      ],
      null,
      null,
    );
    expect(result.groups).toEqual([
      { name: 'News', count: 2 },
      { name: 'Sport', count: 1 },
    ]);
  });

  it('labels a missing group-title as (none) rather than dropping it', () => {
    const result = classifyEntries([entry({ groupName: null })], null, null);
    expect(result.groups).toEqual([{ name: '(none)', count: 1 }]);
  });

  it('applies the include pattern against group-title', () => {
    const entries = [
      entry({ externalId: '1', groupName: 'News FR' }),
      entry({ externalId: '2', groupName: 'Sport FR' }),
    ];
    const result = classifyEntries(entries, /^news/i, null);
    expect(result.live.map((e) => e.externalId)).toEqual(['1']);
  });

  it('applies the exclude pattern against group-title, taking priority over include', () => {
    const entries = [
      entry({ externalId: '1', groupName: 'News FR' }),
      entry({ externalId: '2', groupName: 'News Adult' }),
    ];
    const result = classifyEntries(entries, /news/i, /adult/i);
    expect(result.live.map((e) => e.externalId)).toEqual(['1']);
  });
});

describe('compileGroupPattern', () => {
  it('returns null for an empty pattern', () => {
    expect(compileGroupPattern(null, 'includeGroupsPattern')).toBeNull();
    expect(compileGroupPattern(undefined, 'includeGroupsPattern')).toBeNull();
  });

  it('compiles a valid pattern case-insensitively', () => {
    const re = compileGroupPattern('^news', 'includeGroupsPattern');
    expect(re?.test('NEWS FR')).toBe(true);
  });

  it('throws a clear BadRequestException for an invalid pattern', () => {
    expect(() => compileGroupPattern('(unterminated', 'includeGroupsPattern')).toThrow(
      BadRequestException,
    );
    try {
      compileGroupPattern('(unterminated', 'includeGroupsPattern');
      fail('expected a throw');
    } catch (err) {
      expect((err as Error).message).toContain('includeGroupsPattern');
    }
  });
});

describe('tryCompilePattern', () => {
  it('never throws, even for an invalid pattern', () => {
    expect(() => tryCompilePattern('(unterminated')).not.toThrow();
    expect(tryCompilePattern('(unterminated')).toBeNull();
  });

  it('still compiles a valid pattern', () => {
    expect(tryCompilePattern('^news')?.test('news fr')).toBe(true);
  });
});
