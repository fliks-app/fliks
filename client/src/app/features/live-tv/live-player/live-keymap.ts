/** What a remote press means in the live player, decided before anything is
 *  done about it. Kept apart from the component because the rule that matters
 *  is a contract, not an effect: a visible overlay owns the D-pad. */
export type LiveKeyAction =
  | { kind: 'none' }
  | { kind: 'zap'; by: 1 | -1 }
  | { kind: 'scrub' }
  | { kind: 'digit'; digit: string }
  | { kind: 'commitNumber' }
  | { kind: 'wake' };

export interface LiveKeyContext {
  /** The controls overlay is on screen, so its focus layer moves on the arrows. */
  visible: boolean;
  guideOpen: boolean;
}

const ZAP_KEYS: Record<string, 1 | -1> = {
  ChannelUp: 1,
  PageUp: 1,
  ChannelDown: -1,
  PageDown: -1,
};

/** Back is deliberately absent: every platform spells it differently and app.ts
 *  already routes it to the player, which unwinds the panel then the bar. */
export function liveKeyAction(key: string, ctx: LiveKeyContext): LiveKeyAction {
  // A dedicated channel key is never ambiguous, whatever holds focus.
  const dedicated = ZAP_KEYS[key];
  if (dedicated) return { kind: 'zap', by: dedicated };

  if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight') {
    if (ctx.guideOpen || ctx.visible) return { kind: 'none' };
    if (key === 'ArrowUp') return { kind: 'zap', by: 1 };
    if (key === 'ArrowDown') return { kind: 'zap', by: -1 };
    return { kind: 'scrub' };
  }

  if (key >= '0' && key <= '9' && key.length === 1) return { kind: 'digit', digit: key };

  if (key === 'Enter') {
    // Inside the panel, OK picks the focused channel.
    if (ctx.guideOpen) return { kind: 'none' };
    // On a bare picture OK raises the bar rather than pressing a button nobody sees.
    return ctx.visible ? { kind: 'commitNumber' } : { kind: 'wake' };
  }
  return { kind: 'none' };
}
