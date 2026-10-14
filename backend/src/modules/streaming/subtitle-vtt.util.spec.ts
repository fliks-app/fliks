import { assToVtt } from './subtitle-vtt.util';

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
