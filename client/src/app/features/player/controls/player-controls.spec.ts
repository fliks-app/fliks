import { PlayerControlsComponent } from './player-controls';

describe('PlayerControlsComponent surface clicks', () => {
  const proto = PlayerControlsComponent.prototype;
  const make = () => {
    const calls: string[] = [];
    const ctrl = {
      isMobileTouch: () => false,
      hasOpenDropdown: () => false,
      togglePlay: { emit: () => calls.push('play') },
      toggleFullscreen: { emit: () => calls.push('fullscreen') },
    } as unknown as PlayerControlsComponent;
    return { ctrl, calls };
  };

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('toggles play once after a single click', () => {
    const { ctrl, calls } = make();
    proto.onSurfaceClick.call(ctrl, new MouseEvent('click', { detail: 1 }));
    vi.advanceTimersByTime(300);
    expect(calls).toEqual(['play']);
  });

  it('only toggles fullscreen on a double click', () => {
    const { ctrl, calls } = make();
    proto.onSurfaceClick.call(ctrl, new MouseEvent('click', { detail: 1 }));
    proto.onSurfaceClick.call(ctrl, new MouseEvent('click', { detail: 2 }));
    proto.onSurfaceDblClick.call(ctrl);
    vi.advanceTimersByTime(300);
    expect(calls).toEqual(['fullscreen']);
  });
});
