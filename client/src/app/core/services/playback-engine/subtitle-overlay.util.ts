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

interface VttCue {
  start: number;
  end: number;
  text: string;
}

export class SubtitleOverlay {
  private el: HTMLDivElement | null = null;
  private cues: VttCue[] = [];
  private visible = false;
  private lastText = '';

  /** Parse a remote WebVTT file and arm it as the active track. */
  async show(url: string): Promise<void> {
    this.visible = true;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('VTT fetch ' + res.status);
      this.cues = parseVtt(await res.text());
    } catch {
      this.cues = [];
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!visible) this.render('');
  }

  clear(): void {
    this.visible = false;
    this.cues = [];
    this.render('');
  }

  /** Render the cue active at `timeSec` (called on every time update). */
  updateAt(timeSec: number): void {
    if (!this.visible) {
      if (this.lastText) this.render('');
      return;
    }
    if (!this.cues.length) return;
    const active = this.cues.find((c) => timeSec >= c.start && timeSec <= c.end);
    this.render(active?.text ?? '');
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
    if (this.el?.parentElement) this.el.parentElement.removeChild(this.el);
    this.el = null;
    this.cues = [];
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
      'z-index: 1000',
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

function parseVtt(raw: string): VttCue[] {
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
