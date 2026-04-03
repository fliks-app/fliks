/**
 * Post-processing actions for SRT subtitle files.
 * Each function takes SRT content as string and returns the processed string.
 */

// ---------------------------------------------------------------------------
// Remove style tags: <i>, <b>, <font>, {\an8}, etc.
// ---------------------------------------------------------------------------
export function removeStyleTags(content: string): string {
  return content
    .replace(/<\/?[a-z][^>]*>/gi, '')       // HTML tags
    .replace(/\{\\[^}]+\}/g, '');           // ASS override tags like {\an8}
}

// ---------------------------------------------------------------------------
// Remove emoji and special unicode characters
// ---------------------------------------------------------------------------
export function removeEmoji(content: string): string {
  return content.replace(
    /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}]/gu,
    '',
  );
}

// ---------------------------------------------------------------------------
// OCR fixes: common OCR misreads
// ---------------------------------------------------------------------------
const OCR_REPLACEMENTS: [RegExp, string][] = [
  [/\bl\b(?=[A-Z])/g, 'I'],         // standalone l before uppercase = I
  [/\bln\b/g, 'In'],                 // ln → In
  [/\bIVIr\b/g, 'Mr'],              // IVIr → Mr
  [/\bIVIrs\b/g, 'Mrs'],
  [/\brn(?=[aeiou])/g, 'm'],        // rn before vowel → m
  [/\b0(?=[a-zA-Z])/g, 'O'],        // 0 before letter → O
  [/(?<=[a-zA-Z])0\b/g, 'O'],       // letter then 0 → O
  [/\|\|/g, 'H'],                    // || → H
  [/\|(?=[a-z])/g, 'l'],            // | before lowercase → l
  [/\|(?=[A-Z])/g, 'I'],            // | before uppercase → I
];

export function fixOcr(content: string): string {
  let result = content;
  for (const [pattern, replacement] of OCR_REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Common fixes: double spaces, empty lines, punctuation
// ---------------------------------------------------------------------------
export function commonFixes(content: string): string {
  return content
    .replace(/  +/g, ' ')                   // double spaces
    .replace(/\. \./g, '..')                 // ". ." → ".."
    .replace(/\.\.\.\./g, '...')             // four dots → three
    .replace(/ +([,.!?;:])/g, '$1')          // space before punctuation
    .replace(/([.!?])\1{3,}/g, '$1$1$1')    // excessive punctuation
    .replace(/^\s*\n/gm, '');                // empty lines within text
}

// ---------------------------------------------------------------------------
// Fix uppercase: convert ALL CAPS text to Title Case / sentence case
// ---------------------------------------------------------------------------
export function fixUppercase(content: string): string {
  const blocks = content.split(/\r?\n\r?\n/);
  return blocks.map((block) => {
    const lines = block.split(/\r?\n/);
    if (lines.length < 3) return block;

    // Only fix text lines (skip index + timestamp)
    const textLines = lines.slice(2).map((line) => {
      // Check if line is ALL CAPS (ignoring punctuation/spaces)
      const letters = line.replace(/[^a-zA-Z]/g, '');
      if (letters.length > 1 && letters === letters.toUpperCase()) {
        // Convert to sentence case
        return line.charAt(0).toUpperCase() + line.slice(1).toLowerCase();
      }
      return line;
    });

    return [...lines.slice(0, 2), ...textLines].join('\n');
  }).join('\n\n');
}

// ---------------------------------------------------------------------------
// Reverse RTL text (for Arabic, Hebrew)
// ---------------------------------------------------------------------------
export function reverseRtl(content: string): string {
  const blocks = content.split(/\r?\n\r?\n/);
  return blocks.map((block) => {
    const lines = block.split(/\r?\n/);
    if (lines.length < 3) return block;

    const textLines = lines.slice(2).map((line) => {
      // Reverse if contains RTL characters
      if (/[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F]/.test(line)) {
        return line.split('').reverse().join('');
      }
      return line;
    });

    return [...lines.slice(0, 2), ...textLines].join('\n');
  }).join('\n\n');
}

// ---------------------------------------------------------------------------
// Adjust times: shift all timestamps by offset (ms)
// ---------------------------------------------------------------------------
export function adjustTimes(content: string, offsetMs: number): string {
  return content.replace(
    /(\d{2}):(\d{2}):(\d{2}),(\d{3})/g,
    (_match, h, m, s, ms) => {
      let totalMs =
        parseInt(h) * 3600000 +
        parseInt(m) * 60000 +
        parseInt(s) * 1000 +
        parseInt(ms) +
        offsetMs;
      if (totalMs < 0) totalMs = 0;

      const hours = Math.floor(totalMs / 3600000);
      totalMs %= 3600000;
      const mins = Math.floor(totalMs / 60000);
      totalMs %= 60000;
      const secs = Math.floor(totalMs / 1000);
      const millis = totalMs % 1000;

      return (
        String(hours).padStart(2, '0') +
        ':' +
        String(mins).padStart(2, '0') +
        ':' +
        String(secs).padStart(2, '0') +
        ',' +
        String(millis).padStart(3, '0')
      );
    },
  );
}

// ---------------------------------------------------------------------------
// Change frame rate: convert timings between frame rates
// ---------------------------------------------------------------------------
export function changeFrameRate(
  content: string,
  fromFps: number,
  toFps: number,
): string {
  if (fromFps <= 0 || toFps <= 0 || fromFps === toFps) return content;
  const ratio = fromFps / toFps;

  return content.replace(
    /(\d{2}):(\d{2}):(\d{2}),(\d{3})/g,
    (_match, h, m, s, ms) => {
      let totalMs =
        parseInt(h) * 3600000 +
        parseInt(m) * 60000 +
        parseInt(s) * 1000 +
        parseInt(ms);

      totalMs = Math.round(totalMs * ratio);

      const hours = Math.floor(totalMs / 3600000);
      totalMs %= 3600000;
      const mins = Math.floor(totalMs / 60000);
      totalMs %= 60000;
      const secs = Math.floor(totalMs / 1000);
      const millis = totalMs % 1000;

      return (
        String(hours).padStart(2, '0') +
        ':' +
        String(mins).padStart(2, '0') +
        ':' +
        String(secs).padStart(2, '0') +
        ',' +
        String(millis).padStart(3, '0')
      );
    },
  );
}

// ---------------------------------------------------------------------------
// Convert SSA/ASS to SRT
// ---------------------------------------------------------------------------
export function assToSrt(content: string): string {
  const events = content.split('\n').filter((l) => l.startsWith('Dialogue:'));
  if (!events.length) return content; // Not ASS format

  const srtBlocks: string[] = [];
  let index = 1;

  for (const line of events) {
    // Dialogue: 0,0:01:23.45,0:01:26.78,Default,,0,0,0,,Text here
    const parts = line.split(',');
    if (parts.length < 10) continue;

    const startRaw = parts[1].trim();
    const endRaw = parts[2].trim();
    const text = parts.slice(9).join(',')
      .replace(/\\N/g, '\n')
      .replace(/\{\\[^}]*\}/g, '')
      .trim();

    if (!text) continue;

    const start = assTimeToSrt(startRaw);
    const end = assTimeToSrt(endRaw);

    srtBlocks.push(`${index}\n${start} --> ${end}\n${text}`);
    index++;
  }

  return srtBlocks.join('\n\n') + '\n';
}

function assTimeToSrt(assTime: string): string {
  // ASS: H:MM:SS.CC → SRT: HH:MM:SS,mmm
  const m = /^(\d+):(\d{2}):(\d{2})\.(\d{2})$/.exec(assTime);
  if (!m) return assTime;
  return (
    m[1].padStart(2, '0') +
    ':' +
    m[2] +
    ':' +
    m[3] +
    ',' +
    m[4] + '0'
  );
}
