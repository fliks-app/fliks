import {
  FormatChoice,
  ProfileDocument,
  applyFormatChoice,
  formatChoice,
  minutesToTime,
  savedBytes,
  timeToMinutes,
} from './optimize';

const video = (codec: ProfileDocument['video']['codec'], goal: ProfileDocument['video']['goal']) =>
  ({ codec, goal }) as ProfileDocument['video'];

describe('format choice mapping', () => {
  it.each([
    ['most_compact', 'auto', 'space'],
    ['playable_everywhere', 'auto', 'compatibility'],
    ['hevc', 'hevc', 'space'],
    ['av1', 'av1', 'space'],
  ] as const)('%s <-> codec %s + goal %s', (choice, codec, goal) => {
    expect(formatChoice(video(codec, goal))).toBe(choice);
    const v = video('auto', 'space');
    applyFormatChoice(v, choice);
    expect(v.codec).toBe(codec);
    if (choice === 'most_compact' || choice === 'playable_everywhere') expect(v.goal).toBe(goal);
  });

  it('keeps the goal when a fixed codec is chosen, and restores it on auto', () => {
    const v = video('auto', 'compatibility');
    applyFormatChoice(v, 'hevc');
    expect(v.goal).toBe('compatibility');
    applyFormatChoice(v, 'most_compact' as FormatChoice);
    expect(v).toMatchObject({ codec: 'auto', goal: 'space' });
  });
});

describe('window time helpers', () => {
  it('round-trips minutes and HH:MM, and refuses a malformed time', () => {
    expect(minutesToTime(22 * 60 + 5)).toBe('22:05');
    expect(timeToMinutes('06:30')).toBe(390);
    expect(timeToMinutes('6:30')).toBeNull();
  });

  it('reports the bytes a job saved, negative when the file grew', () => {
    expect(savedBytes({ inSize: 100, outSize: 60 })).toBe(40);
    expect(savedBytes({ inSize: 100, outSize: 120 })).toBe(-20);
    expect(savedBytes({ inSize: null, outSize: 1 })).toBeNull();
  });
});
