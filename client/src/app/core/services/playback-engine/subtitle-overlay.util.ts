import {
  SUBTITLE_SIZE_MAP,
  SUBTITLE_COLOR_MAP,
  SUBTITLE_SHADOW_MAP,
  SUBTITLE_BG_MAP,
} from '../player-settings.service';

/**
 * DOM-rendered subtitle overlay shared by the TV engines (Tizen AVPlay,
 * webOS native `<video>`). Those pipelines either reject HTTPS external
 * subtitle paths (AVPlay) or give no styleable cue API, so we fetch the
 * WebVTT ourselves, parse the cues, and paint the active one into a
 * fixed positioned div on top of the hardware video surface.
 */

export interface VttCue {
  start: number;
  end: number;
  text: string;
}

export class SubtitleOverlay {
  private el: HTMLDivElement | null = null;
  private cues: VttCue[] = [];
  /** Index into `cues` near the last queried time, advanced incrementally so
   *  `updateAt` stays O(1) per tick instead of scanning every cue. */
  private cursor = 0;
  private visible = false;
  private lastText = '';
  private disposed = false;

  /** Parse a remote WebVTT file and arm it as the active track. */
  async show(url: string): Promise<void> {
    this.visible = true;
    this.disposed = false;
    let cues: VttCue[] = [];
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('VTT fetch ' + res.status);
      cues = parseVtt(await res.text());
    } catch {
      cues = [];
    }
    // destroy() may have run while the fetch was in flight — don't repopulate
    // cues after teardown.
    if (this.disposed) return;
    this.cues = cues;
    this.cursor = 0;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!visible) this.render('');
  }

  clear(): void {
    this.visible = false;
    this.cues = [];
    this.cursor = 0;
    this.render('');
  }

  /** Render the cue active at `timeSec` (called on every time update). */
  updateAt(timeSec: number): void {
    if (!this.visible) {
      if (this.lastText) this.render('');
      return;
    }
    if (!this.cues.length) return;
    // Advance the cursor past cues that have ended, and rewind it on a
    // backward jump (seek/loop), so each tick costs O(1) amortised instead of
    // a full linear scan. Cues are start-sorted by the VTT parser.
    while (this.cursor < this.cues.length - 1 && timeSec > this.cues[this.cursor].end) {
      this.cursor++;
    }
    while (this.cursor > 0 && timeSec < this.cues[this.cursor].start) {
      this.cursor--;
    }
    const cue = this.cues[this.cursor];
    const active = cue && timeSec >= cue.start && timeSec <= cue.end ? cue.text : '';
    this.render(active);
  }

  /** Same preset enums Shaka consumes from `player-settings.service`. */
  setStyle(style: {
    size?: string;
    color?: string;
    shadow?: string;
    background?: string;
    bottomMargin?: number;
  }): void {
    const el = this.ensureEl();
    if (!el) return;
    if (style.size) {
      el.style.fontSize = SUBTITLE_SIZE_MAP[style.size] ?? SUBTITLE_SIZE_MAP['normal'];
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
      el.style.bottom = `${Math.max(0, style.bottomMargin)}vh`;
    }
  }

  destroy(): void {
    this.disposed = true;
    if (this.el?.parentElement) this.el.parentElement.removeChild(this.el);
    this.el = null;
    this.cues = [];
    this.cursor = 0;
    this.visible = false;
    this.lastText = '';
  }

  private ensureEl(): HTMLDivElement | null {
    if (this.el?.isConnected) return this.el;
    if (typeof document === 'undefined') return null;
    const el = document.createElement('div');
    el.id = 'fliks-tv-subtitle';
    el.style.cssText = [
      'position: fixed',
      'left: 50%',
      'bottom: 10vh',
      'transform: translateX(-50%)',
      'max-width: 80vw',
      'padding: 6px 14px',
      'background: transparent',
      'color: #fff',
      'font-size: 3vh',
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
    document.body.appendChild(el);
    this.el = el;
    return el;
  }

  private render(text: string): void {
    const el = this.ensureEl();
    if (!el) return;
    if (text === this.lastText) return;
    this.lastText = text;
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
    if (text) cues.push({ start, end, text });
  }
  return cues;
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
