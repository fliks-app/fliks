import { assToVtt, srtToVtt } from './subtitle-vtt.util';

describe('srtToVtt', () => {
  it('turns {\\an8} into top placement and strips the tag', () => {
    const srt =
      "1\r\n00:01:01,151 --> 00:01:04,570\r\n{\\an8}T'as presque pas\r\ncette fois.\r\n\r\n" +
      '2\r\n0:01:05,697 --> 0:01:07,281\r\n<font color="#fff"><i>Bravo</i></font>\r\n';
    expect(srtToVtt(srt)).toBe(
      'WEBVTT\n\n' +
        "00:01:01.151 --> 00:01:04.570 line:5%\nT'as presque pas\ncette fois.\n\n" +
        '00:01:05.697 --> 00:01:07.281\n<i>Bravo</i>\n',
    );
  });

  it('does not merge the next cue when the blank separator carries stray whitespace', () => {
    const srt =
      '1\n00:00:01,000 --> 00:00:02,000\nA\n \n2\n00:00:03,000 --> 00:00:04,000\nB\n';
    expect(srtToVtt(srt)).toBe(
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nA\n\n00:00:03.000 --> 00:00:04.000\nB\n',
    );
  });

  it('starts a new cue at the next timing line when the blank separator is missing entirely', () => {
    const srt =
      '1\n00:00:01,000 --> 00:00:02,000\nA\n2\n00:00:03,000 --> 00:00:04,000\nB\n';
    expect(srtToVtt(srt)).toBe(
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nA\n\n00:00:03.000 --> 00:00:04.000\nB\n',
    );
  });

  it('maps corner alignments', () => {
    const srt =
      '1\n00:00:01,000 --> 00:00:02,000\n{\\an1}A\n\n2\n00:00:03,000 --> 00:00:04,000\n{\\an9}B\n';
    expect(srtToVtt(srt)).toContain(
      '00:00:01.000 --> 00:00:02.000 position:10% align:left\nA',
    );
    expect(srtToVtt(srt)).toContain(
      '00:00:03.000 --> 00:00:04.000 line:5% position:90% align:right\nB',
    );
  });
});

describe('assToVtt', () => {
  const ass = [
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1',
    'Style: Top,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,8,10,10,10,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\an8\\c&H00FF00&}Green, top\\N{\\i1}line two',
    'Dialogue: 0,0:00:04.00,0:00:05.00,Top,,0,0,0,,Style top',
    'Dialogue: 0,0:00:06.00,0:00:07.00,Default,,0,0,0,,{\\an8}',
  ].join('\n');

  it('keeps inline and style alignment, converts b/i/u, drops empty cues', () => {
    expect(assToVtt(ass)).toBe(
      'WEBVTT\n\n' +
        '00:00:01.000 --> 00:00:03.000 line:5%\nGreen, top\n<i>line two</i>\n\n' +
        '00:00:04.000 --> 00:00:05.000 line:5%\nStyle top\n',
    );
  });
});
