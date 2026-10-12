import { afterEach, vi } from 'vitest';
import { SubtitleOverlay, parseVtt, type VttCue } from './subtitle-overlay.util';
import { NATIVE_SUBTITLE_SIZE_SCALE, WEBOS_CUE_SIZE_BOOST } from '../../utils/subtitle-presets';
import { domCueFontSize } from '../player-settings.service';

describe('SubtitleOverlay', () => {
  afterEach(() => {
    document.getElementById('fliks-tv-subtitle')?.remove();
    document.querySelector('.player-container')?.remove();
  });

  it('mounts in .player-container, re-parenting once it exists', () => {
    const overlay = new SubtitleOverlay();
    overlay.setStyle({ color: 'white' });
    expect(document.getElementById('fliks-tv-subtitle')?.parentElement).toBe(document.body);

    const container = document.createElement('div');
    container.className = 'player-container';
    document.body.appendChild(container);
    overlay.setStyle({ color: 'white' });
    expect(document.getElementById('fliks-tv-subtitle')?.parentElement).toBe(container);
  });

  it('shifts the webOS ladder up one notch', () => {
    expect(domCueFontSize(NATIVE_SUBTITLE_SIZE_SCALE['normal'] * WEBOS_CUE_SIZE_BOOST)).toBe(
      domCueFontSize(NATIVE_SUBTITLE_SIZE_SCALE['xlarge']),
    );
  });

  it('reads top placement from the line setting', () => {
    const cues = parseVtt(
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.000 line:5%\nTop\n\n00:00:03.000 --> 00:00:04.000\nBottom\n\n00:00:05.000 --> 00:00:06.000 line:-1\nLast line',
    );
    expect(cues.map((c) => [c.text, c.top])).toEqual([
      ['Top', true],
      ['Bottom', false],
      ['Last line', false],
    ]);
    expect(cues[0].start).toBe(1);
  });

  it('sorts cues by start time', () => {
    const cues = parseVtt('WEBVTT\n\n00:00:05.000 --> 00:00:06.000\nB\n\n00:00:01.000 --> 00:00:02.000\nA');
    expect(cues.map((c) => c.text)).toEqual(['A', 'B']);
  });

  describe('playback', () => {
    const cue = (start: number, end: number, text: string, top = false): VttCue => ({ start, end, text, top });
    const el = () => document.getElementById('fliks-tv-subtitle');
    const shown = (o: SubtitleOverlay, cues: VttCue[]) => {
      o.select({ id: 1e9, cues });
      o.setVisible(true);
    };
    const load = (o: SubtitleOverlay, body: string) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          text: async () => `WEBVTT\n\n00:00:00.000 --> 00:00:09.000\n${body}`,
        }),
      );
      return o.load('u');
    };

    afterEach(() => vi.unstubAllGlobals());

    it('renders every cue active at the same time, in order', () => {
      const o = new SubtitleOverlay();
      shown(o, [cue(0, 10, 'Dialogue'), cue(2, 4, 'Sign', true), cue(3, 9, 'Other')]);
      o.updateAt(3.5);
      expect(el()?.innerHTML).toBe('Dialogue<br>Sign<br>Other');
      o.updateAt(5);
      expect(el()?.innerHTML).toBe('Dialogue<br>Other');
      o.updateAt(20);
      expect(el()?.style.display).toBe('none');
    });

    it('follows a backward seek', () => {
      const o = new SubtitleOverlay();
      shown(o, [cue(1, 2, 'A'), cue(5, 6, 'B')]);
      o.updateAt(5.5);
      o.updateAt(1.5);
      expect(el()?.innerHTML).toBe('A');
    });

    it('swaps tracks at once, painting at the last known time', () => {
      const o = new SubtitleOverlay();
      shown(o, [cue(0, 10, 'Old')]);
      o.updateAt(5);
      o.select({ id: 1e9 + 1, cues: [cue(0, 10, 'New')] });
      expect(el()?.innerHTML).toBe('New');
    });

    it('ignores a handle superseded by a newer selection', async () => {
      const o = new SubtitleOverlay();
      o.setVisible(true);
      const slow = await load(o, 'slow');
      const fast = await load(o, 'fast');
      o.select(fast);
      o.select(slow);
      o.updateAt(1);
      expect(el()?.innerHTML).toBe('fast');
    });

    it('rejects when the file cannot be loaded', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
      await expect(new SubtitleOverlay().load('x')).rejects.toThrow('404');
    });

    it('drops a handle that completes after destroy', async () => {
      const o = new SubtitleOverlay();
      const pending = load(o, 'late');
      o.destroy();
      o.select(await pending);
      o.setVisible(true);
      o.updateAt(1);
      expect(el()?.style.display).not.toBe('block');
    });
  });
});
