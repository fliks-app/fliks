import { SubtitleOverlay } from './subtitle-overlay.util';
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
});
