/**
 * Clean downloaded subtitle content by removing ads, HI tags, and unwanted lines.
 */

/** Common ad patterns found in subtitle files */
const AD_PATTERNS: RegExp[] = [
  /opensubtitles/i,
  /subscene/i,
  /addic7ed/i,
  /sub(s|title)?\s*(by|from|ripped|downloaded)/i,
  /sync(ed|hronized)?\s*(by|&|and)\s/i,
  /www\.\S+\.\S+/i,
  /http[s]?:\/\/\S+/i,
  /support\s+us\s+and\s+become/i,
  /advertise\s+your\s+product/i,
  /a]?]?[a-z]*sub[a-z]*\.(com|org|net|io)/i,
  /please\s+rate\s+this\s+subtitle/i,
  /captioning\s+sponsored\s+by/i,
  /captions\s+(by|copyright|paid)/i,
];

/**
 * Bracketed sound descriptions, half-width and CJK full-width.
 * Matched across line breaks: an HI span often wraps mid-cue.
 */
const HI_SPANS: RegExp[] = [
  /\[[\s\S]{1,300}?\]/g,
  /\([\s\S]{1,300}?\)/g,
  /（[\s\S]{1,300}?）/g,
  /［[\s\S]{1,300}?］/g,
];

/** Music, phone and line-continuation markers, incl. CJK subtitle conventions. */
const HI_SYMBOLS = /[♪-♯¶\u{1F3B5}\u{1F3B6}\u{1F4F1}☎☏➡⇒]/gu;

/** A line left with nothing but dashes, dots or CJK wave marks is noise. */
const JUNK_LINE = /^[～〜~.…\-–—•\s]*$/;

/** Speaker label at line start: `MAN:`, `- Rose:`. Colon must end the label. */
const LABEL_LINE = /^([ \t]*)((?:[-–—][ \t]*)?)([^\n:]{1,30}):(?=[ \t]|$)/gm;

/** A label that reads like a name: capitalised, at most three words. */
const NAME_LABEL = /^\p{Lu}[\p{L}'’.\-]*(?: \p{Lu}[\p{L}'’.\-]*){0,2}$/u;

/**
 * Sound cues written as a bare uppercase line, with no brackets to key on.
 * ponytail: English cue vocabulary — other languages fall back to the bracket
 * and label rules, which are language-agnostic.
 */
const HI_CAPS_CUE =
  /\b(LAUGH|CHUCKL|GIGGL|APPLAU|CLAP|CHEER|MUSIC|SONG|SINGING|PLAYING|THEME|SIGH|GASP|GRUNT|GROAN|MOAN|PANT|SCREAM|SHOUT|YELL|WHISPER|MUMBL|MUTTER|SOB|SNIFF|COUGH|SNORE|KNOCK|DOOR|BELL|PHONE|RING|BEEP|BUZZ|SIREN|ALARM|GUNSHOT|GUNFIRE|EXPLOSION|CRASH|BANG|THUD|CLANG|FOOTSTEP|ENGINE|TIRES|HORN|WIND|RAIN|THUNDER|BIRD|DOG|BARK|CLICK|CLATTER|RUSTL|SQUEAK|CREAK|SPLASH|STATIC|INDISTINCT|INAUDIBLE|CHATTER|SPEAKING|CONTINUES|NARRATOR|ANNOUNCER|VOICE|OVER|ON TV|ON RADIO)/;

export interface CleanerOptions {
  /** Remove lines matching ad patterns (default: true) */
  removeAds?: boolean;
  /** Remove HI tags like [music], (sighs), ♪ (default: false) */
  removeHiTags?: boolean;
  /** Custom regex patterns to remove lines (user-configured) */
  customExclusions?: string[];
}

/** Keep `(?)` and `(12)`: a span is HI only if it holds real words. */
function isSoundSpan(span: string): boolean {
  const inner = span.slice(1, -1).trim();
  return inner.length >= 2 && /[\p{L}\p{N}]/u.test(inner);
}

function stripSpansAndSymbols(text: string): string {
  let out = text;
  for (const re of HI_SPANS) {
    out = out.replace(re, (m) => (isSoundSpan(m) ? '' : m));
  }
  return out.replace(HI_SYMBOLS, '');
}

function isCapsLabel(label: string): boolean {
  const upper = label.replace(/[^\p{Lu}]/gu, '');
  return upper.length >= 2 && !/\p{Ll}/u.test(label);
}

/**
 * Mixed-case labels are only safe to strip when they recur: a real speaker name
 * comes back, whereas `Look: it's fine` is a one-off line of dialogue.
 */
function recurringNameLabels(cues: string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const cue of cues) {
    for (const m of cue.matchAll(LABEL_LINE)) {
      const label = m[3].trim();
      if (!NAME_LABEL.test(label)) continue;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  return new Set(
    [...counts].filter(([, n]) => n >= 2).map(([label]) => label),
  );
}

function stripLabels(text: string, recurring: Set<string>): string {
  return text.replace(LABEL_LINE, (match, indent, dash, label: string) => {
    const trimmed = label.trim();
    if (isCapsLabel(trimmed) || recurring.has(trimmed)) return indent + dash;
    return match;
  });
}

/** Share of text lines that are fully uppercase — a whole sub can be shouted. */
function uppercaseRatio(cues: string[]): number {
  let total = 0;
  let caps = 0;
  for (const cue of cues) {
    for (const line of cue.split('\n')) {
      if (!/\p{L}/u.test(line)) continue;
      total++;
      if (!/\p{Ll}/u.test(line)) caps++;
    }
  }
  return total ? caps / total : 0;
}

function isCapsSoundLine(line: string): boolean {
  const letters = line.replace(/[^\p{L}]/gu, '');
  if (letters.length < 4 || /\p{Ll}/u.test(line) || /[!?]/.test(line))
    return false;
  return HI_CAPS_CUE.test(line);
}

function tidy(text: string, shrunk: boolean): string {
  const lines = text
    .replace(/<(\w+)[^>]*>\s*<\/\1>/g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t]{2,}/g, ' ').trim())
    .filter((l) => l.length > 0 && !JUNK_LINE.test(l));

  // A leading dialogue dash is meaningless once the other speaker's line is gone
  if (shrunk && lines.length === 1) {
    lines[0] = lines[0].replace(/^[-–—][ \t]*/, '');
  }
  return lines.filter((l) => l.length > 0).join('\n');
}

/**
 * Clean an SRT subtitle buffer.
 * Returns the cleaned buffer.
 */
export function cleanSubtitle(
  buffer: Buffer,
  options: CleanerOptions = {},
): Buffer {
  const removeAds = options.removeAds !== false;
  const removeHiTags = options.removeHiTags ?? false;

  const content = buffer.toString('utf-8');

  // Parse custom exclusion regexes
  const customPatterns = (options.customExclusions ?? [])
    .filter((p) => p.trim())
    .map((p) => {
      try {
        return new RegExp(p, 'i');
      } catch {
        return null;
      }
    })
    .filter((r): r is RegExp => r !== null);

  // Split into SRT blocks (separated by blank lines)
  const blocks = content.split(/\r?\n\r?\n/);
  const kept: { header: string[]; text: string; raw?: true }[] = [];

  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    if (lines.length < 2) {
      if (block.trim()) kept.push({ header: [], text: block, raw: true });
      continue;
    }

    // Check if any text line (after index + timestamp) matches ad patterns
    const textLines = lines.slice(2);
    const textContent = textLines.join(' ');

    let isAd = false;
    if (removeAds) {
      isAd = AD_PATTERNS.some((p) => p.test(textContent));
    }
    if (!isAd && customPatterns.length) {
      isAd = customPatterns.some((p) => p.test(textContent));
    }

    if (isAd) continue; // Skip this entire subtitle block

    kept.push({ header: lines.slice(0, 2), text: textLines.join('\n') });
  }

  if (removeHiTags) {
    // Spans first: uppercase ratio and recurring labels both read cleaner text,
    // otherwise a single mixed-case sound description skews the whole file.
    const stripped = kept.map((b) =>
      b.raw ? b.text : stripSpansAndSymbols(b.text),
    );
    const recurring = recurringNameLabels(stripped);
    const dropCapsLines = uppercaseRatio(stripped) < 0.7;

    for (let i = 0; i < kept.length; i++) {
      if (kept[i].raw) continue;
      let text = stripLabels(stripped[i], recurring);
      if (dropCapsLines) {
        text = text
          .split('\n')
          .filter((l) => !isCapsSoundLine(l))
          .join('\n');
      }
      kept[i].text = tidy(text, text.length !== kept[i].text.length);
    }
  }

  // Renumber, dropping blocks whose text is now empty
  let index = 1;
  const result = kept
    .filter((b) => b.text.trim().length > 0)
    .map((b) => {
      if (b.raw) return b.text;
      const header = [...b.header];
      if (/^\d+$/.test(header[0].trim())) header[0] = String(index++);
      return [...header, b.text].join('\n');
    });

  return Buffer.from(result.join('\n\n') + '\n', 'utf-8');
}
