import type { StructuredLyrics } from '../api/lyrics.models';
import { sides } from './karaoke-session';

/** One palette for lyrics, mic dots, score chips and the pitch lane; the mark says it without colour. */
export const SINGER_COLOURS = ['#22c55e', '#38bdf8', '#f472b6', '#facc15'];
export const SINGER_MARKS = ['●', '▲', '■', '◆'];

export interface SingerStyle {
  /** 1-based singer number, 0 for a line sung by everyone. */
  n: number;
  /** Null for a group line: it keeps the main text colour. */
  colour: string | null;
  mark: string;
  /** Lane bar: singer 1 filled, others outlined, group filled with an outline. */
  shape: 'filled' | 'outlined' | 'both';
  name?: string;
}

/** Style of a line's agent; null on a solo song or a background line. */
export function singerStyle(doc: StructuredLyrics, agentId?: string): SingerStyle | null {
  const agents = sides(doc);
  if (agents.length < 2) return null;
  const id = agentId ?? agents[0];
  if (doc.agents?.find((a) => a.id === id)?.role === 'group') {
    return { n: 0, colour: null, mark: SINGER_MARKS[0] + SINGER_MARKS[1], shape: 'both' };
  }
  const i = agents.indexOf(id);
  if (i < 0) return null;
  return {
    n: i + 1,
    colour: SINGER_COLOURS[i % SINGER_COLOURS.length],
    mark: SINGER_MARKS[i % SINGER_MARKS.length],
    shape: i === 0 ? 'filled' : 'outlined',
    name: doc.agents?.find((a) => a.id === id)?.name,
  };
}
