import { describe, expect, it } from 'vitest';
import { buildPartyIcs, escapeIcsText, foldIcsLine, icsUtc } from './party-ics';

const base = {
  id: 42,
  name: 'Movie night',
  startsAt: new Date('2026-11-05T20:30:00.000Z'),
  link: 'https://fliks.example/party/abc',
  now: new Date('2026-10-24T11:00:05.123Z'),
};

describe('party ics', () => {
  it('escapes backslash, semicolon, comma and newlines', () => {
    expect(escapeIcsText('a\\b;c,d\ne\r\nf')).toBe('a\\\\b\;c\\,d\\ne\\nf');
  });

  it('formats UTC without separators or milliseconds', () => {
    expect(icsUtc(new Date('2026-01-02T03:04:05.678Z'))).toBe('20260102T030405Z');
  });

  it('folds at 75 octets with a leading space on continuations', () => {
    const lines = foldIcsLine('X:' + 'a'.repeat(200)).split('\r\n');
    expect(lines.length).toBeGreaterThan(2);
    for (const l of lines) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
    expect(lines.slice(1).every((l) => l.startsWith(' '))).toBe(true);
    expect(lines.map((l, i) => (i ? l.slice(1) : l)).join('')).toBe('X:' + 'a'.repeat(200));
  });

  it('never splits a multi-byte character', () => {
    const folded = foldIcsLine('S:' + 'é'.repeat(100));
    for (const l of folded.split('\r\n')) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
    expect(folded.split('\r\n').map((l, i) => (i ? l.slice(1) : l)).join('')).toBe('S:' + 'é'.repeat(100));
  });

  it('builds the event with CRLF endings, UTC start, runtime and alarm', () => {
    const ics = buildPartyIcs({ ...base, runtimeMin: 105 });
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    for (const l of [
      'UID:party-42@fliks',
      'DTSTAMP:20261024T110005Z',
      'DTSTART:20261105T203000Z',
      'DURATION:PT1H45M',
      'SUMMARY:Movie night',
      'URL:https://fliks.example/party/abc',
      'TRIGGER:-PT15M',
    ]) {
      expect(ics).toContain(l + '\r\n');
    }
  });

  it('defaults to two hours without a runtime', () => {
    expect(buildPartyIcs(base)).toContain('DURATION:PT2H\r\n');
    expect(buildPartyIcs({ ...base, runtimeMin: 0 })).toContain('DURATION:PT2H\r\n');
    expect(buildPartyIcs({ ...base, runtimeMin: 45 })).toContain('DURATION:PT45M\r\n');
  });
});
