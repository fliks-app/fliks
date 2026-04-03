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

/** HI tag patterns: [music playing], (sighs), ♪, etc. */
const HI_TAG_PATTERNS: RegExp[] = [
  /\[.*?\]/g,
  /\(.*?\)/g,
  /♪[^♪]*♪/g,
  /♪/g,
  /♫/g,
  /🎵/g,
  /🎶/g,
];

export interface CleanerOptions {
  /** Remove lines matching ad patterns (default: true) */
  removeAds?: boolean;
  /** Remove HI tags like [music], (sighs), ♪ (default: false) */
  removeHiTags?: boolean;
  /** Custom regex patterns to remove lines (user-configured) */
  customExclusions?: string[];
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

  let content = buffer.toString('utf-8');

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
  const cleaned: string[] = [];

  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    if (lines.length < 2) {
      cleaned.push(block);
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

    // Clean HI tags from text lines if requested
    if (removeHiTags) {
      const cleanedLines = textLines.map((line) => {
        let cleaned = line;
        for (const pattern of HI_TAG_PATTERNS) {
          cleaned = cleaned.replace(pattern, '');
        }
        return cleaned.trim();
      }).filter((line) => line.length > 0);

      if (cleanedLines.length === 0) continue; // All text was HI tags
      cleaned.push([...lines.slice(0, 2), ...cleanedLines].join('\n'));
    } else {
      cleaned.push(block);
    }
  }

  // Renumber blocks
  let index = 1;
  const result = cleaned.map((block) => {
    const lines = block.split(/\r?\n/);
    if (lines.length >= 2 && /^\d+$/.test(lines[0].trim())) {
      lines[0] = String(index++);
    }
    return lines.join('\n');
  });

  return Buffer.from(result.join('\n\n') + '\n', 'utf-8');
}
