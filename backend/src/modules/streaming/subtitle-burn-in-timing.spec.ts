import { atCueTime, SubtitleBurnInService } from './subtitle-burn-in.service';

describe('text burn-in timing', () => {
  it('renders against cue time: source PTS minus the container start, restored after', () => {
    expect(atCueTime("subtitles='/s.srt'", 2.778667)).toBe(
      "setpts=PTS-2.778667/TB,subtitles='/s.srt',setpts=PTS+2.778667/TB",
    );
  });

  it('shifts the other way for a container starting before 0', () => {
    expect(atCueTime("ass='/s.ass'", -1.022)).toBe(
      "setpts=PTS+1.022/TB,ass='/s.ass',setpts=PTS-1.022/TB",
    );
  });

  it('leaves a container starting at 0 alone', () => {
    expect(atCueTime("subtitles='/s.srt'", 0)).toBe("subtitles='/s.srt'");
  });

  it('wraps the filter the service builds for a text file', () => {
    const filter = SubtitleBurnInService.prototype.buildFilter.call({}, {
      type: 'text',
      videoPath: '/m/v.ts',
      subtitlePath: '/m/v.srt',
      codec: 'subrip',
      cueOffsetSeconds: 95000,
    });
    expect(filter).toBe("setpts=PTS-95000/TB,subtitles='/m/v.srt',setpts=PTS+95000/TB");
  });
});
