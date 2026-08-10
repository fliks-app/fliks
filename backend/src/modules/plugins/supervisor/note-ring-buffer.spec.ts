import { NoteRingBuffer } from './note-ring-buffer';

describe('NoteRingBuffer', () => {
  it('shifts in FIFO order and drains to empty', () => {
    const ring = new NoteRingBuffer();
    ring.push({ m: 'event', p: 1 });
    ring.push({ m: 'event', p: 2 });
    expect(ring.size).toBe(2);
    expect(ring.shift()).toEqual({ m: 'event', p: 1 });
    expect(ring.shift()).toEqual({ m: 'event', p: 2 });
    expect(ring.shift()).toBeUndefined();
    expect(ring.size).toBe(0);
  });

  it('caps at 64 entries, dropping the oldest and counting drops', () => {
    const ring = new NoteRingBuffer();
    for (let i = 0; i < 70; i++) ring.push({ m: 'event', p: i });
    expect(ring.size).toBe(64);
    expect(ring.dropped).toBe(6);
    // the oldest 6 (p: 0..5) were dropped; the next one in line is p: 6
    expect(ring.shift()).toEqual({ m: 'event', p: 6 });
  });
});
