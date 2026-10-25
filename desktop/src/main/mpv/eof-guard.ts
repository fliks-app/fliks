/** A real end sits at the duration; a stream that died after its reconnects stops short by more than a segment. */
export const PREMATURE_EOF_GAP_S = 10;

export function isPrematureEof(duration: number, position: number): boolean {
  return duration > 0 && duration - position > PREMATURE_EOF_GAP_S;
}
