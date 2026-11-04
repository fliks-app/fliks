export type ReaderKeyAction = 'left' | 'right' | 'next' | 'prev' | 'start' | 'end' | 'toc' | 'settings' | 'notes' | 'search' | 'bookmark' | 'chrome' | 'close';

/** A condition the toolkit subscribes to; it fires at once with the current value, then on each change. */
export interface KeyGate {
  set(open: boolean): void;
  subscribe(cb: (open: boolean) => void): () => void;
}

export function keyGate(initial = true): KeyGate {
  let value = initial;
  const subs = new Set<(open: boolean) => void>();
  return {
    set(open) {
      value = open;
      subs.forEach((cb) => cb(open));
    },
    subscribe(cb) {
      cb(value);
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
}

interface KeyCombo {
  keyCode: number;
  shift?: boolean;
  suppressOnInteractiveElement: boolean | string[];
  condition?: KeyGate;
}

interface KeyBinding {
  type: ReaderKeyAction;
  keyCombos: KeyCombo[];
}

const TEXT_FIELDS = ['input', 'textarea', 'select'];
/** Enter and Space belong to a focused control; the other keys to a focused text field or slider. */
const typed = (keyCode: number, extra: { shift?: boolean; condition?: KeyGate } = {}): KeyCombo => ({
  keyCode,
  suppressOnInteractiveElement: keyCode === 13 || keyCode === 32 ? true : TEXT_FIELDS,
  ...extra,
});

/**
 * Arrows turn toward their screen side, whatever the reading direction; Page and Space keys step along it.
 * `arrows` closes the arrow keys while a remote's D-pad has to move focus instead.
 */
export const readerKeyBindings = (arrows?: KeyGate): KeyBinding[] => [
  { type: 'left', keyCombos: [typed(37, { condition: arrows })] },
  { type: 'right', keyCombos: [typed(39, { condition: arrows })] },
  { type: 'next', keyCombos: [typed(34), typed(32)] },
  { type: 'prev', keyCombos: [typed(33), typed(32, { shift: true })] },
  { type: 'start', keyCombos: [typed(36)] },
  { type: 'end', keyCombos: [typed(35)] },
  { type: 'toc', keyCombos: [typed(84)] },
  { type: 'settings', keyCombos: [typed(83)] },
  { type: 'notes', keyCombos: [typed(78)] },
  { type: 'search', keyCombos: [typed(70)] },
  { type: 'bookmark', keyCombos: [typed(66)] },
  { type: 'chrome', keyCombos: [typed(13)] },
  { type: 'close', keyCombos: [typed(27)] },
];

const BINDINGS = readerKeyBindings();

/** Same rule as the toolkit's: a modifier a combo does not list must not be pressed. */
export function readerKeyAction(e: KeyboardEvent): ReaderKeyAction | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  const hit = BINDINGS.find((b) =>
    b.keyCombos.some((c) => c.keyCode === e.keyCode && !!c.shift === e.shiftKey),
  );
  return hit?.type ?? null;
}
