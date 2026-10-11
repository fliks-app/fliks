import { parseEdl } from './edl-parser';

const r = (start: number, end: number, action: 'cut' | 'mute' | 'commercial') => ({ start, end, action });

describe('parseEdl', () => {
  it('parses the mplayer time-based sample and counts scene markers', () => {
    const text = [
      '5.3   7.1    0',
      '15    16.7   1',
      '## This is a comment kodi should happily ignore when parsing',
      '420   822    3',
      '1     255.3  2',
      '720.1        2',
    ].join('\n');
    const out = parseEdl(text);
    expect(out.ranges).toEqual([r(5.3, 7.1, 'cut'), r(15, 16.7, 'mute'), r(420, 822, 'commercial')]);
    expect(out.sceneMarkers).toBe(2);
    expect(out.rejected).toEqual([]);
  });

  it('parses the mixed clock/seconds sample', () => {
    const text = '5.3     7.1     0\n15      16.7    1\n7:00    13:42   3\n1       4:15.3  2\n12:00.1         2\n';
    const out = parseEdl(text);
    expect(out.ranges).toEqual([r(5.3, 7.1, 'cut'), r(15, 16.7, 'mute'), r(420, 822, 'commercial')]);
    expect(out.sceneMarkers).toBe(2);
  });

  it('parses interleaved cuts', () => {
    const out = parseEdl('5.3   7.1    0\n15    16.7   3\n18    19     0\n25    36.7   3\n');
    expect(out.ranges).toHaveLength(4);
    expect(out.rejected).toEqual([]);
  });

  it('resolves the frame-based sample against fps and rejects it without fps', () => {
    const text = '#127   #170    0\n#360   #400    1\n#10080 #19728  3\n#1     #6127   2\n#17282         2\n';
    const out = parseEdl(text, 25);
    expect(out.ranges).toEqual([r(5.08, 6.8, 'cut'), r(14.4, 16, 'mute'), r(403.2, 789.12, 'commercial')]);
    expect(out.sceneMarkers).toBe(2);
    const none = parseEdl(text);
    expect(none.ranges).toEqual([]);
    expect(none.rejected.map((x) => x.reason)).toEqual(['fps', 'fps', 'fps', 'fps', 'fps']);
  });

  it('keeps the auto-wind sample, comment skipped, aligned columns', () => {
    const text = [
      '## first commbreak should be automatically removed',
      '0    1     3',
      '10   22    3',
      '30   32    3',
      '37   50    3',
      '52   60    3',
      '62   65.1  3',
    ].join('\n');
    const out = parseEdl(text);
    expect(out.ranges).toHaveLength(6);
    expect(out.ranges[5]).toEqual(r(62, 65.1, 'commercial'));
    expect(out.rejected).toEqual([]);
  });

  it('rejects the unsupported Comskip txt format line by line', () => {
    const out = parseEdl('FILE PROCESSING COMPLETE\r\n------------------------\r\n12693\t17792\r\n');
    expect(out.ranges).toEqual([]);
    expect(out.rejected).toEqual([
      { line: 1, reason: 'action' },
      { line: 2, reason: 'fields' },
      { line: 3, reason: 'action' },
    ]);
  });

  it('handles BOM, CR line endings, tabs and extra columns', () => {
    const out = parseEdl('﻿1\t2\t0\r3 4 1 extra\r5 6 3');
    expect(out.ranges.map((x) => x.action)).toEqual(['cut', 'mute', 'commercial']);
  });

  it('pads and truncates the clock fraction', () => {
    const out = parseEdl('1:02.5 1:03.123456 0\n1:00:00 1:00:01 0');
    expect(out.ranges).toEqual([r(62.5, 63.123, 'cut'), r(3600, 3601, 'cut')]);
  });

  it('rejects bad times, actions, order and overlaps but allows touching', () => {
    const out = parseEdl(
      ['-1 5 0', '1,5 3 0', '5 5 0', '9 4 0', '1 2 7', '1 2 x', '10 20 0', '15 25 1', '20 30 1', '1', '4 5'].join('\n'),
    );
    expect(out.ranges).toEqual([r(10, 20, 'cut'), r(20, 30, 'mute')]);
    expect(out.rejected.map((x) => x.reason)).toEqual([
      'time', 'time', 'order', 'order', 'action', 'action', 'overlap', 'fields', 'action',
    ]);
  });

  it('sorts by start and caps the range count', () => {
    expect(parseEdl('30 40 0\n10 20 0').ranges.map((x) => x.start)).toEqual([10, 30]);
    const many = Array.from({ length: 10001 }, (_, i) => `${i * 2} ${i * 2 + 1} 0`).join('\n');
    const out = parseEdl(many);
    expect(out.ranges).toHaveLength(10000);
    expect(out.rejected).toEqual([{ line: 10001, reason: 'limit' }]);
  });

  it('accepts .5 and 5. like atof, still no sign or comma', () => {
    const out = parseEdl('.5 5. 0\n+1 2 0\n6 7,5 0');
    expect(out.ranges).toEqual([r(0.5, 5, 'cut')]);
    expect(out.rejected.map((x) => x.reason)).toEqual(['time', 'time']);
  });

  it('reads the action as a leading integer', () => {
    const out = parseEdl('1 2 03\n3 4 1abc\n5 6 0.0\n7 8 x1\n9 10 4');
    expect(out.ranges.map((x) => x.action)).toEqual(['commercial', 'mute', 'cut']);
    expect(out.rejected.map((x) => x.reason)).toEqual(['action', 'action']);
  });

  it('checks the limit before scanning for overlaps, in linear-ish time', () => {
    const many = Array.from({ length: 40000 }, (_, i) => `${i * 2} ${i * 2 + 1} 0`).join('\n');
    const t = Date.now();
    const out = parseEdl(many);
    expect(Date.now() - t).toBeLessThan(500);
    expect(out.ranges).toHaveLength(10000);
    expect(out.rejected).toHaveLength(30000);
  });

  it('detects overlaps against either neighbour regardless of input order', () => {
    const out = parseEdl('10 20 0\n30 40 0\n15 16 0\n25 35 0\n20 30 1\n5 10 1');
    expect(out.ranges.map((x) => [x.start, x.end])).toEqual([[5, 10], [10, 20], [20, 30], [30, 40]]);
    expect(out.rejected.map((x) => x.line)).toEqual([3, 4]);
  });
});
