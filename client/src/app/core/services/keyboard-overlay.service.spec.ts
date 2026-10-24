import { KeyboardOverlayService } from './keyboard-overlay.service';

const m = vi.hoisted(() => ({
  platform: 'android',
  overlay: vi.fn(() => Promise.resolve()),
  listeners: {} as Record<string, (info: { keyboardHeight: number }) => void>,
  remove: vi.fn(() => Promise.resolve()),
  getResizeMode: vi.fn(() => Promise.resolve({ mode: 'native' })),
  setResizeMode: vi.fn(() => Promise.resolve()),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => m.platform !== 'web', getPlatform: () => m.platform },
  registerPlugin: () => ({ setKeyboardOverlay: m.overlay }),
}));
vi.mock('@capacitor/keyboard', () => ({
  KeyboardResize: { None: 'none' },
  Keyboard: {
    addListener: (name: string, fn: (info: { keyboardHeight: number }) => void) => {
      m.listeners[name] = fn;
      return Promise.resolve({ remove: m.remove });
    },
    getResizeMode: m.getResizeMode,
    setResizeMode: m.setResizeMode,
  },
}));

describe('KeyboardOverlayService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of Object.keys(m.listeners)) delete m.listeners[k];
    m.platform = 'android';
  });

  it('toggles the Android overlay once for nested users and tracks the height', () => {
    const svc = new KeyboardOverlayService();
    svc.enter();
    svc.enter();
    expect(m.overlay).toHaveBeenCalledTimes(1);
    expect(m.overlay).toHaveBeenCalledWith({ enabled: true });

    m.listeners['keyboardWillShow']({ keyboardHeight: 140 });
    expect(svc.height()).toBe(140);
    m.listeners['keyboardWillHide']({ keyboardHeight: 0 });
    expect(svc.height()).toBe(0);

    svc.leave();
    expect(m.overlay).toHaveBeenCalledTimes(1);
    svc.leave();
    expect(m.overlay).toHaveBeenLastCalledWith({ enabled: false });
  });

  it('switches the iOS resize mode off and restores the previous one', async () => {
    m.platform = 'ios';
    const svc = new KeyboardOverlayService();
    svc.enter();
    await vi.waitFor(() => expect(m.setResizeMode).toHaveBeenCalledWith({ mode: 'none' }));
    svc.leave();
    expect(m.setResizeMode).toHaveBeenLastCalledWith({ mode: 'native' });
    expect(m.overlay).not.toHaveBeenCalled();
  });

  it('does nothing on the web', () => {
    m.platform = 'web';
    const svc = new KeyboardOverlayService();
    svc.enter();
    svc.leave();
    expect(m.overlay).not.toHaveBeenCalled();
    expect(m.listeners['keyboardWillShow']).toBeUndefined();
  });
});
