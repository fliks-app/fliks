import { afterEach, vi } from 'vitest';
import { SubtitleOverlay, parseVtt, renderCueText, type VttCue } from './subtitle-overlay.util';
import { NATIVE_SUBTITLE_SIZE_SCALE, WEBOS_CUE_SIZE_BOOST } from '../../utils/subtitle-presets';
import { domCueFontSize } from '../player-settings.service';

describe('SubtitleOverlay', () => {
  afterEach(() => {
    document.getElementById('fliks-tv-subtitle')?.remove();
    document.getElementById('fliks-tv-subtitle-top')?.remove();
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

  describe('renderCueText', () => {
    const render = (text: string) => {
      const el = document.createElement('div');
      renderCueText(el, text);
      return el;
    };

    it('keeps b/i/u/br as elements and decodes entities as text', () => {
      const el = render('a <i>b</i><br><b><u>c</u></b> &lt;x&gt; &amp;');
      expect(el.innerHTML).toBe('a <i>b</i><br><b><u>c</u></b> &lt;x&gt; &amp;');
      expect(el.textContent).toBe('a bc <x> &');
    });

    it('renders hostile text as text, including across joined cues', () => {
      const joined = ['<img src=x onerror=alert(1)//', 'second', '<script>alert(1)</script>', '<b onclick=x>'].join('<br>');
      const el = render(joined);
      expect(el.querySelector('img, script')).toBeNull();
      expect([...el.querySelectorAll('*')].every((n) => n.localName === 'br')).toBe(true);
      expect(el.textContent).toContain('<img src=x onerror=alert(1)//');
    });

    it('ignores a stray closing tag and closes unbalanced openers', () => {
      expect(render('</b>x<i>y').innerHTML).toBe('x<i>y</i>');
    });
  });

  it('never parses overlapping hostile cues as HTML', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          'WEBVTT\n\n00:00:00.000 --> 00:00:09.000\nhi <img src=x onerror=alert(1)//\n\n00:00:01.000 --> 00:00:09.000\nsecond',
      }),
    );
    const o = new SubtitleOverlay();
    o.select(await o.load('u'));
    o.setVisible(true);
    o.updateAt(2);
    const bottom = document.getElementById('fliks-tv-subtitle');
    expect(bottom?.querySelector('img')).toBeNull();
    expect(bottom?.textContent).toContain('<img src=x onerror=alert(1)//');
    vi.unstubAllGlobals();
    o.destroy();
  });

  it('sorts cues by start time', () => {
    const cues = parseVtt('WEBVTT\n\n00:00:05.000 --> 00:00:06.000\nB\n\n00:00:01.000 --> 00:00:02.000\nA');
    expect(cues.map((c) => c.text)).toEqual(['A', 'B']);
  });

  describe('playback', () => {
    const cue = (start: number, end: number, text: string, top = false): VttCue => ({ start, end, text, top });
    const el = () => document.getElementById('fliks-tv-subtitle');
    const topEl = () => document.getElementById('fliks-tv-subtitle-top');
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

    it('renders overlapping cues of one band together, in start order', () => {
      const o = new SubtitleOverlay();
      shown(o, [cue(0, 10, 'Dialogue'), cue(3, 9, 'Other')]);
      o.updateAt(3.5);
      expect(el()?.innerHTML).toBe('Dialogue<br>Other');
      expect(topEl()?.style.display).toBe('none');
      o.updateAt(20);
      expect(el()?.style.display).toBe('none');
    });

    it('splits a top cue from bottom cues into two bands', () => {
      const o = new SubtitleOverlay();
      shown(o, [cue(0, 10, 'Dialogue'), cue(2, 4, 'Sign', true), cue(3, 9, 'Other'), cue(3.2, 4.5, 'Sign 2', true)]);
      o.updateAt(3.5);
      expect(el()?.innerHTML).toBe('Dialogue<br>Other');
      expect(topEl()?.innerHTML).toBe('Sign<br>Sign 2');
      expect(topEl()?.style.top).toBe('5vh');
      expect(el()?.style.bottom).toBe('10vh');
      o.updateAt(5);
      expect(topEl()?.style.display).toBe('none');
      expect(el()?.style.display).toBe('block');
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
