import { SubtitleOverlay, parseVtt } from './subtitle-overlay.util';
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
});
