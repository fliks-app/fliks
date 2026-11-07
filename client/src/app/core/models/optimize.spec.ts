import { FormatChoice, ProfileDocument, applyFormatChoice, formatChoice } from './optimize';

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
