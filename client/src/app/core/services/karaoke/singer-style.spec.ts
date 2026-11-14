import type { StructuredLyrics } from '../api/lyrics.models';
import { singerStyle } from './singer-style';

const doc = (agents: StructuredLyrics['agents']) => ({ id: 1, kind: 'main', lang: 'en', synced: true, offset: 0, line: [], agents }) as unknown as StructuredLyrics;

describe('singer style', () => {
  const duet = doc([{ id: 'v1', role: 'main' }, { id: 'v2', role: 'voice', name: 'Ana' }, { id: 'g', role: 'group' }, { id: 'b', role: 'bg' }]);

  it('marks each side and the group, never by colour alone', () => {
    expect(singerStyle(duet, 'v1')).toMatchObject({ n: 1, mark: '●', shape: 'filled' });
    expect(singerStyle(duet, 'v2')).toMatchObject({ n: 2, mark: '▲', shape: 'outlined', name: 'Ana' });
    expect(singerStyle(duet, 'g')).toMatchObject({ n: 0, mark: '●▲', colour: null, shape: 'both' });
    expect(singerStyle(duet)?.n).toBe(1);
  });

  it('has no style on a solo song or a background line', () => {
    expect(singerStyle(doc([{ id: 'v1', role: 'main' }]), 'v1')).toBeNull();
    expect(singerStyle(duet, 'b')).toBeNull();
  });
});
