export type ReaderKeyAction = 'left' | 'right' | 'next' | 'prev' | 'close';

interface KeyBinding {
  type: ReaderKeyAction;
  keyCombos: { keyCode: number; shift?: boolean }[];
}

/** Arrows turn toward their screen side, whatever the reading direction; Page and Space keys step along it. */
export const READER_KEY_BINDINGS: KeyBinding[] = [
  { type: 'left', keyCombos: [{ keyCode: 37 }] },
  { type: 'right', keyCombos: [{ keyCode: 39 }] },
  { type: 'next', keyCombos: [{ keyCode: 34 }, { keyCode: 32 }] },
  { type: 'prev', keyCombos: [{ keyCode: 33 }, { keyCode: 32, shift: true }] },
  { type: 'close', keyCombos: [{ keyCode: 27 }] },
];

/** Same rule as the toolkit's: a modifier a combo does not list must not be pressed. */
export function readerKeyAction(e: KeyboardEvent): ReaderKeyAction | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  const hit = READER_KEY_BINDINGS.find((b) =>
    b.keyCombos.some((c) => c.keyCode === e.keyCode && !!c.shift === e.shiftKey),
  );
  return hit?.type ?? null;
}
