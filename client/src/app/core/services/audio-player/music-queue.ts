/** One track to play: what the pages hand to the player. */
export type MusicTrackRequest = {
  itemId: number;
  mediaId: number;
  title: string;
  artists: string;
  albumTitle: string;
  coverUrl: string | null;
  durationSeconds: number | null;
  gain: number | null;
  peak: number | null;
  albumGain: number | null;
  albumPeak: number | null;
};

export type Repeat = 'off' | 'all' | 'one';

/** The play order of a music session; entries are copies, so one track can sit twice. */
export class MusicQueue {
  private original: MusicTrackRequest[] = [];
  private list: MusicTrackRequest[] = [];
  private pos = -1;
  private shuffled = false;
  repeat: Repeat = 'off';

  get tracks(): readonly MusicTrackRequest[] {
    return this.list;
  }

  get index(): number {
    return this.pos;
  }

  get current(): MusicTrackRequest | null {
    return this.list[this.pos] ?? null;
  }

  get shuffle(): boolean {
    return this.shuffled;
  }

  /** True when every track belongs to one album, so its album gain applies. */
  get singleAlbum(): boolean {
    return this.list.length > 0 && this.list.every((t) => t.mediaId === this.list[0].mediaId);
  }

  set(tracks: readonly MusicTrackRequest[], startIndex = 0, shuffle = false, random: () => number = Math.random): void {
    this.original = tracks.map((t) => ({ ...t }));
    this.list = [...this.original];
    this.pos = this.list.length ? Math.min(Math.max(0, startIndex), this.list.length - 1) : -1;
    this.shuffled = false;
    this.setShuffle(shuffle, random);
  }

  /** Takes a play order as it is, flagged shuffled or not, without reordering it. */
  adopt(tracks: readonly MusicTrackRequest[], index: number, shuffled: boolean): void {
    this.original = tracks.map((t) => ({ ...t }));
    this.list = [...this.original];
    this.pos = this.list.length ? Math.min(Math.max(0, index), this.list.length - 1) : -1;
    this.shuffled = shuffled;
  }

  /** Shuffling keeps the current track first; turning it off restores the original order around it. */
  setShuffle(on: boolean, random: () => number = Math.random): void {
    const cur = this.current;
    this.shuffled = on;
    if (!cur) return;
    if (on) {
      const rest = this.list.filter((t) => t !== cur);
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [rest[i], rest[j]] = [rest[j], rest[i]];
      }
      this.list = [cur, ...rest];
      this.pos = 0;
    } else {
      const kept = new Set(this.list);
      this.list = this.original.filter((t) => kept.has(t));
      this.pos = this.list.indexOf(cur);
    }
  }

  /** The track after the current one when playback runs on by itself; null stops it (repeat one restarts in place). */
  peekNext(): MusicTrackRequest | null {
    if (this.repeat === 'one') return null;
    return this.neighbour(1);
  }

  /** Moves to the next track on a skip or an end; repeat one keeps its current track. */
  next(auto: boolean): MusicTrackRequest | null {
    if (auto && this.repeat === 'one') return this.current;
    const t = this.neighbour(1);
    if (t) this.pos = this.list.indexOf(t);
    return t;
  }

  previous(): MusicTrackRequest | null {
    const t = this.neighbour(-1);
    if (t) this.pos = this.list.indexOf(t);
    return t;
  }

  playAt(i: number): MusicTrackRequest | null {
    if (i < 0 || i >= this.list.length) return null;
    this.pos = i;
    return this.list[i];
  }

  addNext(tracks: readonly MusicTrackRequest[]): void {
    this.insert(this.pos + 1, tracks);
  }

  addLast(tracks: readonly MusicTrackRequest[]): void {
    this.insert(this.list.length, tracks);
  }

  /** Removes the entry at `i`; removing the current track leaves `current` on the one that follows it. */
  remove(i: number): void {
    const t = this.list[i];
    if (!t) return;
    this.list.splice(i, 1);
    this.original = this.original.filter((o) => o !== t);
    if (i < this.pos) this.pos--;
    if (this.pos >= this.list.length) this.pos = this.list.length - 1;
  }

  move(from: number, to: number): void {
    if (from === to || !this.list[from] || to < 0 || to >= this.list.length) return;
    const cur = this.current;
    const [t] = this.list.splice(from, 1);
    this.list.splice(to, 0, t);
    this.pos = this.list.indexOf(cur!);
    if (!this.shuffled) this.original = [...this.list];
  }

  clear(): void {
    this.original = [];
    this.list = [];
    this.pos = -1;
  }

  neighbour(step: 1 | -1): MusicTrackRequest | null {
    const n = this.list.length;
    if (!n || this.pos < 0) return null;
    const i = this.pos + step;
    if (i >= 0 && i < n) return this.list[i];
    return this.repeat === 'all' ? this.list[(i + n) % n] : null;
  }

  private insert(at: number, tracks: readonly MusicTrackRequest[]): void {
    const copies = tracks.map((t) => ({ ...t }));
    this.list.splice(at, 0, ...copies);
    if (this.shuffled) this.original.push(...copies);
    else this.original = [...this.list];
    if (this.pos < 0 && copies.length) this.pos = 0;
  }
}
