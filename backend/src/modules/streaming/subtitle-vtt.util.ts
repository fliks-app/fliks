import { parseSrt } from '../subtitles/srt.util';

/** SSA v4 `\a` / style numbering → the numpad layout `\an` uses. */
const SSA_TO_NUMPAD: Record<number, number> = {
  1: 1,
  2: 2,
  3: 3,
  5: 7,
  6: 8,
  7: 9,
  9: 4,
  10: 5,
  11: 6,
};

/** Numpad alignment (`\an`) → WebVTT cue settings. Percentages, not line
 *  numbers: every renderer we ship (Shaka UI, Media3, AVFoundation, TV overlay)
 *  maps a percentage the same way. */
function cueSettings(an: number | undefined): string {
  if (!an || an < 1 || an > 9) return '';
  const settings: string[] = [];
  if (an >= 7) settings.push('line:5%');
  else if (an >= 4) settings.push('line:45%');
  if (an % 3 === 1) settings.push('position:10%', 'align:left');
  else if (an % 3 === 0) settings.push('position:90%', 'align:right');
  return settings.length ? ' ' + settings.join(' ') : '';
}

/** Last alignment override in a cue's `{...}` blocks, as a numpad value. */
function inlineAlignment(text: string): number | undefined {
  let an: number | undefined;
  for (const block of text.match(/\{[^}]*\}/g) ?? []) {
    for (const m of block.matchAll(/\\an(\d)|\\a(\d+)/g)) {
      an = m[1] ? +m[1] : SSA_TO_NUMPAD[+m[2]];
    }
  }
  return an;
}

/** Keep only the markup WebVTT and every renderer share: b, i, u. */
function keepBasicTags(text: string): string {
  return text.replace(/<\/?(?!(?:b|i|u)>)[a-z][^>]*>/gi, '');
}

function cue(start: string, end: string, settings: string, text: string) {
  return `${start} --> ${end}${settings}\n${text}`;
}

function vttTime(t: string): string {
  const [h, m, s] = t.replace(',', '.').split(':');
  return `${h.padStart(2, '0')}:${m}:${s}`;
}

export function srtToVtt(srt: string): string {
  const cues: string[] = [];
  for (const { timing, text } of parseSrt(srt)) {
    const m =
      /(\d+:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d+:\d{2}:\d{2}[,.]\d{3})/.exec(
        timing,
      );
    if (!m) continue;
    const body = keepBasicTags(text.replace(/\{\\[^}]*\}/g, '')).trim();
    if (!body) continue;
    cues.push(
      cue(
        vttTime(m[1]),
        vttTime(m[2]),
        cueSettings(inlineAlignment(text)),
        body,
      ),
    );
  }
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

/** Override block → the b/i/u tags it toggles; everything else is dropped. */
function assOverridesToTags(block: string, open: Set<string>): string {
  let out = '';
  for (const m of block.matchAll(/\\([biu])(\d+)/g)) {
    const [tag, on] = [m[1], m[2] !== '0'];
    if (on && !open.has(tag)) {
      open.add(tag);
      out += `<${tag}>`;
    } else if (!on && open.has(tag)) {
      open.delete(tag);
      out += `</${tag}>`;
    }
  }
  return out;
}

function assTime(t: string): string {
  // H:MM:SS.CC → HH:MM:SS.CC0
  const m = /^(\d+):(\d{2}):(\d{2})\.(\d{2})$/.exec(t.trim());
  return m ? `${m[1].padStart(2, '0')}:${m[2]}:${m[3]}.${m[4]}0` : '';
}

/** Reads field positions from the `Format:` lines, so any column order works. */
export function assToVtt(ass: string): string {
  const styleAlign = new Map<string, number>();
  let section = '';
  let styleFormat: string[] = [];
  let eventFormat: string[] = [];
  const cues: string[] = [];

  for (const raw of ass.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      section = line.toLowerCase();
      continue;
    }
    const sep = line.indexOf(':');
    if (sep < 0) continue;
    const key = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1);

    if (key === 'format') {
      const fields = value.split(',').map((f) => f.trim().toLowerCase());
      if (section.includes('styles')) styleFormat = fields;
      else if (section === '[events]') eventFormat = fields;
    } else if (key === 'style' && styleFormat.length) {
      const f = value.split(',');
      const name = f[styleFormat.indexOf('name')]?.trim();
      const align = parseInt(f[styleFormat.indexOf('alignment')], 10);
      if (name && !isNaN(align)) {
        const legacy = section === '[v4 styles]';
        styleAlign.set(name, legacy ? SSA_TO_NUMPAD[align] : align);
      }
    } else if (key === 'dialogue' && eventFormat.length) {
      const textIdx = eventFormat.indexOf('text');
      const f = value.split(',');
      const text = f.slice(textIdx).join(',');
      const start = assTime(f[eventFormat.indexOf('start')] ?? '');
      const end = assTime(f[eventFormat.indexOf('end')] ?? '');
      if (!start || !end || textIdx < 0) continue;

      const open = new Set<string>();
      let body = text
        .replace(/\{([^}]*)\}/g, (_, block: string) =>
          assOverridesToTags(block, open),
        )
        .replace(/\\n/gi, '\n')
        .replace(/\\h/g, ' ');
      for (const tag of open) body += `</${tag}>`;
      body = body.trim();
      if (!body.replace(/<[^>]*>/g, '').trim()) continue;

      const style = f[eventFormat.indexOf('style')]?.trim().replace(/^\*/, '');
      const an = inlineAlignment(text) ?? styleAlign.get(style ?? '');
      cues.push(cue(start, end, cueSettings(an), body));
    }
  }
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}
