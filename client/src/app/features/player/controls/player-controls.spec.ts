import { PlayerControlsComponent } from './player-controls';

describe('PlayerControlsComponent surface clicks', () => {
  const proto = PlayerControlsComponent.prototype;
  const make = (canControl = true) => {
    const calls: string[] = [];
    const ctrl = {
      isMobileTouch: () => false,
      hasOpenDropdown: () => false,
      canControlPlayback: () => canControl,
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

  it('does nothing when the party host holds playback', () => {
    const { ctrl, calls } = make(false);
    proto.onSurfaceClick.call(ctrl, new MouseEvent('click', { detail: 1 }));
    vi.advanceTimersByTime(300);
    expect(calls).toEqual([]);
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

describe('PlayerControlsComponent appearance target', () => {
  const proto = PlayerControlsComponent.prototype;
  const row = { panel: 'size', field: 'subtitleSize', styleKey: 'size', labelKey: 'k', options: [{ value: 'large', label: 'L' }] };
  const style = { size: 'normal', color: 'white', shadow: 'drop', background: 'transparent', bottomMargin: 0 };
  const make = (styled: unknown) => {
    const patch = vi.fn();
    const ctrl = { styled: () => styled, playerSettings: { patch, settings: () => ({ subtitleSize: 'small' }) } };
    return { ctrl: ctrl as unknown as PlayerControlsComponent, patch };
  };

  it('edits the output style while casting, not the local settings', () => {
    const out = { subtitleStyle: () => style, setSubtitleStyle: vi.fn() };
    const { ctrl, patch } = make(out);
    proto.setAppearance.call(ctrl, row as never, 'large');
    expect(out.setSubtitleStyle).toHaveBeenCalledWith({ ...style, size: 'large' });
    expect(patch).not.toHaveBeenCalled();
    proto.setAppearance.call(ctrl, { ...row, styleKey: 'bottomMargin' } as never, 10);
    expect(out.setSubtitleStyle).toHaveBeenCalledWith({ ...style, bottomMargin: 10 });
    expect(proto.currentOption.call(ctrl, { ...row, options: [{ value: 'normal', label: 'N' }] } as never)?.label).toBe('N');
  });

  it('edits the local settings otherwise', () => {
    const { ctrl, patch } = make(null);
    proto.setAppearance.call(ctrl, row as never, 'large');
    expect(patch).toHaveBeenCalledWith({ subtitleSize: 'large' });
  });
});
