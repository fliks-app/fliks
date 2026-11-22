export type LastSearchOutcome = 'grabbed' | 'none' | 'busy' | 'timed_out';

/** What the last automatic search of a wanted title found; `null` on the wire means never searched. */
export interface LastSearch {
  at: string;
  outcome: LastSearchOutcome;
  found: number;
  eligible: number;
  /** The three most frequent rejection codes. */
  rejections: { code: string; count: number }[];
  /** Display names of the sources that did not answer; managers only. */
  failed: string[];
  nextAt: string | null;
}
