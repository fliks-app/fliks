import { cleanSubtitle } from './subtitle-cleaner';

const clean = (srt: string): string =>
  cleanSubtitle(Buffer.from(srt, 'utf-8'), {
    removeAds: false,
    removeHiTags: true,
  }).toString('utf-8');

const cue = (n: number, text: string): string =>
  `${n}\n00:00:0${n},000 --> 00:00:0${n},900\n${text}`;

describe('cleanSubtitle — HI removal', () => {
  it('drops cues that are only a sound description', () => {
    const out = clean([cue(1, '[door slams]'), cue(2, 'Hello.')].join('\n\n'));
    expect(out).not.toContain('door slams');
    expect(out).toContain('Hello.');
    expect(out).toContain('1\n00:00:02,000'); // renumbered
  });

  it('removes a span that wraps across two lines', () => {
    const out = clean(cue(1, '[distant\nthunder rumbling]\nRun!'));
    expect(out).not.toContain('thunder');
    expect(out).toContain('Run!');
  });

  it('handles CJK full-width parentheses and markers', () => {
    const out = clean(
      [
        cue(1, '（咲太）おはよう'),
        cue(2, '（学生たちの笑い声）'),
        cue(3, '♬～'),
        cue(4, '📱 もしもし ➡'),
      ].join('\n\n'),
    );
    expect(out).toContain('おはよう');
    expect(out).not.toContain('咲太');
    expect(out).not.toContain('笑い声');
    expect(out).not.toContain('♬');
    expect(out).not.toContain('➡');
    expect(out).toContain('もしもし');
  });

  it('keeps short parentheticals that carry no words', () => {
    expect(clean(cue(1, 'Really(?)'))).toContain('Really(?)');
  });

  it('strips uppercase speaker labels but keeps the dialogue', () => {
    const out = clean(cue(1, '- MAN: Get down!\n- WOMAN: Now!'));
    expect(out).toContain('- Get down!');
    expect(out).toContain('- Now!');
    expect(out).not.toContain('MAN');
  });

  it('only strips a caps label when the colon ends it', () => {
    expect(clean(cue(1, 'Meet me at 10:30 AM'))).toContain('10:30 AM');
  });

  it('strips a mixed-case label only when it recurs', () => {
    const recurring = clean(
      [cue(1, 'Rose: Hi there.'), cue(2, 'Rose: Again.')].join('\n\n'),
    );
    expect(recurring).toContain('Hi there.');
    expect(recurring).not.toContain('Rose:');

    expect(clean(cue(1, "Look: it's fine."))).toContain("Look: it's fine.");
  });

  it('drops bare uppercase sound cues', () => {
    const out = clean([cue(1, 'DOOR CREAKING'), cue(2, 'Hi.')].join('\n\n'));
    expect(out).not.toContain('CREAKING');
    expect(out).toContain('Hi.');
  });

  it('keeps uppercase lines when the whole subtitle is uppercase', () => {
    const out = clean(
      [
        cue(1, 'DOOR CREAKING'),
        cue(2, 'WHAT ARE YOU DOING'),
        cue(3, 'I AM LEAVING NOW'),
      ].join('\n\n'),
    );
    expect(out).toContain('CREAKING');
  });

  it('keeps style tags but drops the ones it empties', () => {
    const out = clean(
      [
        cue(1, '<font color="#00ff00">Hello</font>'),
        cue(2, '<i>[sighs]</i>'),
      ].join('\n\n'),
    );
    expect(out).toContain('<font color="#00ff00">Hello</font>');
    expect(out).not.toContain('sighs');
    expect(out).not.toContain('<i>');
  });

  it('leaves the subtitle untouched when the option is off', () => {
    const srt = cue(1, '[door slams]\nMAN: Hello');
    const out = cleanSubtitle(Buffer.from(srt, 'utf-8'), {
      removeAds: false,
    }).toString('utf-8');
    expect(out).toContain('[door slams]');
    expect(out).toContain('MAN: Hello');
  });
});
