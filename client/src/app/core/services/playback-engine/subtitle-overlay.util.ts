import {
  SUBTITLE_COLOR_MAP,
  SUBTITLE_SHADOW_MAP,
  SUBTITLE_BG_MAP,
  domCueFontSize,
} from '../player-settings.service';
import { NATIVE_SUBTITLE_SIZE_SCALE } from '../../utils/subtitle-presets';

/**
 * DOM-rendered subtitle overlay shared by the TV engines (Tizen AVPlay,
 * webOS native `<video>`). Those pipelines either reject HTTPS external
 * subtitle paths (AVPlay) or give no styleable cue API, so we fetch the
 * WebVTT ourselves, parse the cues, and paint the active ones into our own
 * div inside the player container.
 */

export interface VttCue {
  start: number;
  end: number;
  text: string;
  /** From the cue's `line:` setting (an SRT `{\an8}` upstream). */
  top?: boolean;
}

/** Opaque result of {@link SubtitleOverlay.load}, applied by {@link SubtitleOverlay.select}. */
export interface SubtitleHandle {
  id: number;
  cues: VttCue[];
}

export class SubtitleOverlay {
  private el: HTMLDivElement | null = null;
  private cues: VttCue[] = [];
  /** `prefixMaxEnd[i]` = latest end among `cues[0..i]`, bounding the backward scan for overlaps. */
  private prefixMaxEnd: number[] = [];
  /** First cue starting after the last queried time, advanced incrementally per tick. */
  private cursor = 0;
  private visible = false;
  private lastText = '';
  private lastTop = false;
  private lastTime = 0;
  private bottom = '10vh';
  private top = '5vh';
  /** Request counter; a handle older than the last applied selection is ignored. */
  private seq = 0;
  private applied = 0;

  /** Multiplies every preset on the ladder, so a platform can shift the whole
   *  scale without redefining the presets. */
  constructor(private readonly sizeScale = 1) {}

  /** Fetch and parse a remote WebVTT file; rejects when it cannot be loaded. */
  async load(url: string): Promise<SubtitleHandle> {
    const id = ++this.seq;
    const res = await fetch(url);
    if (!res.ok) throw new Error('VTT fetch ' + res.status);
    return { id, cues: parseVtt(await res.text()) };
  }

  /** Swap in a loaded track at once; a handle superseded by a newer selection is dropped. */
  select(handle: SubtitleHandle): void {
    if (handle.id < this.applied) return;
    this.applied = handle.id;
    this.cues = handle.cues;
    let max = -Infinity;
    this.prefixMaxEnd = this.cues.map((c) => (max = Math.max(max, c.end)));
    this.cursor = 0;
    this.updateAt(this.lastTime);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.updateAt(this.lastTime);
  }

  clear(): void {
    this.applied = ++this.seq;
    this.visible = false;
    this.cues = [];
    this.prefixMaxEnd = [];
    this.cursor = 0;
    this.render('');
  }

  /** Render every cue active at `timeSec` (called on every time update). */
  updateAt(timeSec: number): void {
    this.lastTime = timeSec;
    if (!this.visible || !this.cues.length) {
      if (this.lastText) this.render('');
      return;
    }
    const { cues } = this;
    while (this.cursor < cues.length && cues[this.cursor].start <= timeSec) this.cursor++;
    while (this.cursor > 0 && cues[this.cursor - 1].start > timeSec) this.cursor--;
    const active: VttCue[] = [];
    for (let i = this.cursor - 1; i >= 0 && this.prefixMaxEnd[i] >= timeSec; i--) {
      if (cues[i].end >= timeSec) active.unshift(cues[i]);
    }
    this.render(active.map((c) => c.text).join('<br>'), active.length > 0 && active.every((c) => c.top));
  }

  /** Same preset enums Shaka consumes from `player-settings.service`. */
  setStyle(style: {
    size?: string;
    color?: string;
    shadow?: string;
    background?: string;
    bottomMargin?: number;
    topMargin?: number;
  }): void {
    const el = this.ensureEl();
    if (!el) return;
    if (style.size) {
      const scale = NATIVE_SUBTITLE_SIZE_SCALE[style.size] ?? NATIVE_SUBTITLE_SIZE_SCALE['normal'];
      el.style.fontSize = domCueFontSize(scale * this.sizeScale);
    }
    if (style.color) {
      el.style.color = SUBTITLE_COLOR_MAP[style.color] ?? SUBTITLE_COLOR_MAP['white'];
    }
    if (style.shadow) {
      el.style.textShadow = SUBTITLE_SHADOW_MAP[style.shadow] ?? SUBTITLE_SHADOW_MAP['drop'];
    }
    if (style.background) {
      el.style.background = SUBTITLE_BG_MAP[style.background] ?? SUBTITLE_BG_MAP['transparent'];
    }
    if (typeof style.bottomMargin === 'number') {
      this.bottom = `${Math.max(0, style.bottomMargin)}vh`;
    }
    if (typeof style.topMargin === 'number') {
      this.top = `${Math.max(0, style.topMargin)}vh`;
    }
    this.place(el, this.lastTop);
  }

  destroy(): void {
    this.applied = ++this.seq;
    if (this.el?.parentElement) this.el.parentElement.removeChild(this.el);
    this.el = null;
    this.cues = [];
    this.prefixMaxEnd = [];
    this.cursor = 0;
    this.visible = false;
    this.lastText = '';
    this.lastTop = false;
  }

  private place(el: HTMLDivElement, top: boolean): void {
    el.style.top = top ? this.top : '';
    el.style.bottom = top ? 'auto' : this.bottom;
  }

  private ensureEl(): HTMLDivElement | null {
    if (typeof document === 'undefined') return null;
    // Must live inside `.player-container` (like Shaka's own text container):
    // it is a z-index 100 stacking context, and on webOS the hardware video
    // surface erases anything painted below it.
    const host = document.querySelector('.player-container') ?? document.body;
    if (this.el?.isConnected) {
      if (this.el.parentElement !== host) host.appendChild(this.el);
      return this.el;
    }
    const el = document.createElement('div');
    el.id = 'fliks-tv-subtitle';
    el.style.cssText = [
      'position: absolute',
      'left: 50%',
      'bottom: 10vh',
      'transform: translateX(-50%)',
      'max-width: 80vw',
      'padding: 6px 14px',
      'background: transparent',
      'color: #fff',
      `font-size: ${domCueFontSize(this.sizeScale)}`,
      'font-weight: 500',
      'line-height: 1.3',
      'text-align: center',
      'text-shadow: 0 2px 4px rgba(0, 0, 0, 0.9)',
      'pointer-events: none',
      // Below the controls row (z-40, raised to z-55 while the sprite preview is
      // up) and above the video: at 1000 a cue covered the seek thumbnail.
      'z-index: 30',
      'white-space: pre-wrap',
      'display: none',
    ].join(';');
    host.appendChild(el);
    this.el = el;
    return el;
  }

  private render(text: string, top = false): void {
    const el = this.ensureEl();
    if (!el) return;
    if (text === this.lastText && top === this.lastTop) return;
    this.lastText = text;
    if (top !== this.lastTop) this.place(el, top);
    this.lastTop = top;
    if (text) {
      el.innerHTML = text;
      el.style.display = 'block';
    } else {
      el.style.display = 'none';
    }
  }
}

export function parseVtt(raw: string): VttCue[] {
  const cues: VttCue[] = [];
  const blocks = raw.replace(/\r\n/g, '\n').split('\n\n');
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    const timeLine = lines.find((l) => l.includes('-->'));
    if (!timeLine) continue;
    const [startStr, endStr] = timeLine.split('-->').map((s) => s.trim());
    const start = vttTimeToSec(startStr);
    const end = vttTimeToSec(endStr);
    if (isNaN(start) || isNaN(end)) continue;
    const textLines = lines.slice(lines.indexOf(timeLine) + 1);
    // Allow <b>, <i>, <u>, <br> so `innerHTML` is safe (third-party sub
    // files; backend just proxies).
    const text = textLines.join('<br>').replace(/<\/?[^>]*>/g, (tag) => {
      if (/^<\/?(b|i|u|br)\s*\/?>$/i.test(tag)) return tag;
      return '';
    });
    // Line numbers count from the top when non-negative; a percentage is a
    // share of the height, and only the upper band counts as top.
    const line = /\bline:(-?[\d.]+)(%?)/.exec(timeLine);
    const top = !!line && (line[2] ? +line[1] < 40 : +line[1] >= 0);
    if (text) cues.push({ start, end, text, top });
  }
  return cues.sort((a, b) => a.start - b.start);
}

function vttTimeToSec(ts: string): number {
  const clean = ts.split(' ')[0];
  const parts = clean.split(':');
  if (parts.length === 3) {
    return +parts[0] * 3600 + +parts[1] * 60 + parseFloat(parts[2]);
  }
  if (parts.length === 2) {
    return +parts[0] * 60 + parseFloat(parts[1]);
  }
  return NaN;
}
