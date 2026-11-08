export const CDG_WIDTH = 300;
export const CDG_HEIGHT = 216;
export const CDG_PACKETS_PER_SECOND = 300;
const PACKET = 24;
const TILE_W = 6;
const TILE_H = 12;

/** A CD+G screen: 300x216 pixels of 16-colour indices, drawn by 24-byte packets (300 per second of audio). */
export class CdgScreen {
  private readonly pixels = new Uint8Array(CDG_WIDTH * CDG_HEIGHT);
  private readonly palette = new Array<number>(16).fill(0);
  private cursor = 0;

  constructor(private readonly data: Uint8Array) {}

  /** The packets up to `ms` of audio applied; going back replays from the start. */
  seek(ms: number): void {
    const end = Math.min(Math.floor((Math.max(0, ms) * CDG_PACKETS_PER_SECOND) / 1000), Math.floor(this.data.length / PACKET));
    if (end < this.cursor) this.reset();
    while (this.cursor < end) this.apply(this.cursor++ * PACKET);
  }

  /** RGBA pixels of the screen; the border preset is ignored. */
  rgba(into: Uint8ClampedArray = new Uint8ClampedArray(CDG_WIDTH * CDG_HEIGHT * 4)): Uint8ClampedArray {
    for (let i = 0; i < this.pixels.length; i++) {
      const c = this.palette[this.pixels[i]];
      into[i * 4] = (c >> 16) & 255;
      into[i * 4 + 1] = (c >> 8) & 255;
      into[i * 4 + 2] = c & 255;
      into[i * 4 + 3] = 255;
    }
    return into;
  }

  private reset(): void {
    this.cursor = 0;
    this.pixels.fill(0);
    this.palette.fill(0);
  }

  private apply(at: number): void {
    const d = this.data;
    if ((d[at] & 0x3f) !== 9) return;
    const p = at + 4;
    switch (d[at + 1] & 0x3f) {
      case 1:
        this.pixels.fill(d[p] & 0xf);
        break;
      case 6:
        this.tile(p, false);
        break;
      case 38:
        this.tile(p, true);
        break;
      case 20:
        this.scroll(p, false);
        break;
      case 24:
        this.scroll(p, true);
        break;
      case 30:
      case 31:
        this.colours(p, (d[at + 1] & 0x3f) === 31 ? 8 : 0);
        break;
    }
  }

  /** Eight colours as two bytes each: 4 bits per channel, scaled to 8. */
  private colours(p: number, from: number): void {
    for (let i = 0; i < 8; i++) {
      const hi = this.data[p + i * 2] & 0x3f;
      const lo = this.data[p + i * 2 + 1] & 0x3f;
      const r = (hi >> 2) & 0xf;
      const g = ((hi & 3) << 2) | ((lo >> 4) & 3);
      const b = lo & 0xf;
      this.palette[from + i] = ((r * 17) << 16) | ((g * 17) << 8) | (b * 17);
    }
  }

  private tile(p: number, xor: boolean): void {
    const d = this.data;
    const c0 = d[p] & 0xf;
    const c1 = d[p + 1] & 0xf;
    const y0 = (d[p + 2] & 0x1f) * TILE_H;
    const x0 = (d[p + 3] & 0x3f) * TILE_W;
    if (x0 + TILE_W > CDG_WIDTH || y0 + TILE_H > CDG_HEIGHT) return;
    for (let y = 0; y < TILE_H; y++) {
      const bits = d[p + 4 + y] & 0x3f;
      for (let x = 0; x < TILE_W; x++) {
        const c = (bits >> (5 - x)) & 1 ? c1 : c0;
        const i = (y0 + y) * CDG_WIDTH + x0 + x;
        this.pixels[i] = xor ? this.pixels[i] ^ c : c;
      }
    }
  }

  /** Whole-cell scrolls (6 px across, 12 down); the fine offsets are not drawn. */
  private scroll(p: number, copy: boolean): void {
    const fill = this.data[p] & 0xf;
    const h = (this.data[p + 1] >> 4) & 3;
    const v = (this.data[p + 2] >> 4) & 3;
    const dx = h === 1 ? TILE_W : h === 2 ? -TILE_W : 0;
    const dy = v === 1 ? TILE_H : v === 2 ? -TILE_H : 0;
    if (!dx && !dy) return;
    const src = this.pixels.slice();
    for (let y = 0; y < CDG_HEIGHT; y++) {
      for (let x = 0; x < CDG_WIDTH; x++) {
        let sx = x - dx;
        let sy = y - dy;
        const inside = sx >= 0 && sx < CDG_WIDTH && sy >= 0 && sy < CDG_HEIGHT;
        sx = (sx + CDG_WIDTH) % CDG_WIDTH;
        sy = (sy + CDG_HEIGHT) % CDG_HEIGHT;
        this.pixels[y * CDG_WIDTH + x] = copy || inside ? src[sy * CDG_WIDTH + sx] : fill;
      }
    }
  }
}
