import type { Readable } from 'stream';

export interface XmltvChannel {
  id: string;
  displayNames: string[];
  iconUrl: string | null;
}

export interface XmltvProgramme {
  channelId: string;
  startsAt: Date;
  endsAt: Date | null;
  title: string;
  subtitle: string | null;
  description: string | null;
  categories: string[];
  iconUrl: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  seriesId: string | null;
  isNew: boolean;
  isLive: boolean;
  rating: string | null;
  year: number | null;
}

/** Handlers return `unknown` rather than `void | Promise<void>`: a union return
 *  type loses TypeScript's void-callback exemption, so `(p) => rows.push(p)`
 *  would not typecheck. Anything thenable is still awaited for backpressure. */
export interface XmltvHandlers {
  onChannel?: (channel: XmltvChannel) => unknown;
  onProgramme?: (programme: XmltvProgramme) => unknown;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeXmlText(raw: string): string {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (whole, name) => ENTITIES[name] ?? whole)
    .trim();
}

/**
 * XMLTV time: `YYYYMMDDHHMMSS` with an optional ` +HHMM` offset. A feed that
 * omits the offset is read in the caller's declared timezone, which is the
 * only thing that stops a guide sitting an hour off all day.
 */
export function parseXmltvDate(
  raw: string | undefined,
  fallbackOffsetMinutes = 0,
): Date | null {
  if (!raw) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/.exec(
    raw.trim(),
  );
  if (!m) return null;
  const [, y, mo, d, h, mi, s, off] = m;
  let offsetMinutes = fallbackOffsetMinutes;
  if (off) {
    const sign = off[0] === '-' ? -1 : 1;
    offsetMinutes =
      sign * (Number(off.slice(1, 3)) * 60 + Number(off.slice(3, 5)));
  }
  const utc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s ?? '0'),
  );
  return new Date(utc - offsetMinutes * 60_000);
}

function attrs(openTag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of openTag.matchAll(/([A-Za-z0-9_:-]+)\s*=\s*"([^"]*)"/g)) {
    out[m[1].toLowerCase()] = decodeXmlText(m[2]);
  }
  return out;
}

/** Prefers `preferredLang`, then the untagged instance, then whichever came first:
 *  a feed with parallel `lang` variants must not silently pick the wrong one. */
function childText(block: string, tag: string, preferredLang?: string): string | null {
  const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, 'gi');
  let first: string | null = null;
  let untagged: string | null = null;
  let preferred: string | null = null;
  for (const m of block.matchAll(re)) {
    const value = decodeXmlText(m[2]);
    if (!value) continue;
    first ??= value;
    const lang = attrs(m[1])['lang'];
    if (!lang) untagged ??= value;
    else if (preferredLang && lang.toLowerCase() === preferredLang.toLowerCase()) preferred ??= value;
  }
  return preferred ?? untagged ?? first;
}

function childTexts(block: string, tag: string): string[] {
  const out: string[] = [];
  for (const m of block.matchAll(
    new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi'),
  )) {
    const value = decodeXmlText(m[1]);
    if (value) out.push(value);
  }
  return out;
}

/** Matches `<new/>` and `<new></new>`, never a `<new-something>` sibling. */
function hasEmptyTag(block: string, tag: string): boolean {
  return new RegExp(`<${tag}\\s*/?>`, 'i').test(block);
}

/** `0.2.0/1` is season 1, episode 3: both indices are zero based. */
function parseXmltvNs(value: string): {
  season: number | null;
  episode: number | null;
} {
  const [seasonPart = '', episodePart = ''] = value.split('.');
  const season = Number.parseInt(seasonPart.split('/')[0]?.trim() ?? '', 10);
  const episode = Number.parseInt(episodePart.split('/')[0]?.trim() ?? '', 10);
  return {
    season: Number.isFinite(season) ? season + 1 : null,
    episode: Number.isFinite(episode) ? episode + 1 : null,
  };
}

function parseOnScreen(value: string): {
  season: number | null;
  episode: number | null;
} {
  const m = /S?\s*(\d{1,3})\s*[EXx]\s*(\d{1,4})/.exec(value);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  const ep = /^E?(\d{1,4})$/.exec(value.trim());
  return { season: null, episode: ep ? Number(ep[1]) : null };
}

function parseEpisodeNums(block: string): {
  season: number | null;
  episode: number | null;
  seriesId: string | null;
} {
  let season: number | null = null;
  let episode: number | null = null;
  let seriesId: string | null = null;
  for (const m of block.matchAll(
    /<episode-num\b([^>]*)>([\s\S]*?)<\/episode-num>/gi,
  )) {
    const system = (attrs(m[1])['system'] ?? 'onscreen').toLowerCase();
    const value = decodeXmlText(m[2]);
    if (!value) continue;
    if (system === 'xmltv_ns') {
      const parsed = parseXmltvNs(value);
      season ??= parsed.season;
      episode ??= parsed.episode;
    } else if (system === 'onscreen') {
      const parsed = parseOnScreen(value);
      season ??= parsed.season;
      episode ??= parsed.episode;
    } else {
      seriesId ??= `${system}:${value}`;
    }
  }
  return { season, episode, seriesId };
}

function toProgramme(
  block: string,
  openTag: string,
  fallbackOffsetMinutes: number,
  preferredLang?: string,
): XmltvProgramme | null {
  const a = attrs(openTag);
  const startsAt = parseXmltvDate(a['start'], fallbackOffsetMinutes);
  const channelId = a['channel'];
  const title = childText(block, 'title', preferredLang);
  if (!startsAt || !channelId || !title) return null;

  const { season, episode, seriesId } = parseEpisodeNums(block);
  const icon = /<icon\b([^>]*)>/i.exec(block);
  const date = childText(block, 'date');
  const year = date ? Number.parseInt(date.slice(0, 4), 10) : Number.NaN;
  // Scoped to <rating>: a <star-rating> carries a <value> too.
  const ratingBlock = /<rating\b[^>]*>([\s\S]*?)<\/rating>/i.exec(block);

  return {
    channelId,
    startsAt,
    endsAt: parseXmltvDate(a['stop'], fallbackOffsetMinutes),
    title,
    subtitle: childText(block, 'sub-title', preferredLang),
    description: childText(block, 'desc', preferredLang),
    categories: childTexts(block, 'category'),
    iconUrl: icon ? (attrs(icon[1])['src'] ?? null) : null,
    seasonNumber: season,
    episodeNumber: episode,
    seriesId,
    isNew: hasEmptyTag(block, 'new'),
    isLive: hasEmptyTag(block, 'live'),
    rating: ratingBlock ? childText(ratingBlock[1], 'value') : null,
    year: Number.isFinite(year) ? year : null,
  };
}

function toChannel(block: string, openTag: string): XmltvChannel | null {
  const id = attrs(openTag)['id'];
  if (!id) return null;
  const icon = /<icon\b([^>]*)>/i.exec(block);
  return {
    id,
    displayNames: childTexts(block, 'display-name'),
    iconUrl: icon ? (attrs(icon[1])['src'] ?? null) : null,
  };
}

/** Index of the closing tag, skipping CDATA sections that may contain one. */
function findClose(buffer: string, from: number, closeTag: string): number {
  let i = from;
  for (;;) {
    const cdata = buffer.indexOf('<![CDATA[', i);
    const close = buffer.indexOf(closeTag, i);
    if (close === -1) return -1;
    if (cdata === -1 || cdata > close) return close;
    const cdataEnd = buffer.indexOf(']]>', cdata);
    if (cdataEnd === -1) return -1;
    i = cdataEnd + 3;
  }
}

/**
 * Streams a guide feed element by element. A published guide runs to hundreds
 * of megabytes, so it is never held as a document: the buffer only ever holds
 * the tail of the current element, and the handler decides what to keep.
 */
export async function parseXmltvStream(
  input: Readable,
  handlers: XmltvHandlers,
  options: { offsetMinutes?: number; language?: string } = {},
): Promise<void> {
  const offset = options.offsetMinutes ?? 0;
  const language = options.language;
  let buffer = '';

  const drain = async (final = false): Promise<void> => {
    for (;;) {
      const progIdx = buffer.indexOf('<programme');
      // No trailing space: a generator that breaks attributes onto their own
      // lines (`<channel\n  id="...">`) must still be recognised.
      const chanIdx = handlers.onChannel ? buffer.indexOf('<channel') : -1;
      const first =
        progIdx === -1
          ? chanIdx
          : chanIdx === -1
            ? progIdx
            : Math.min(progIdx, chanIdx);
      if (first === -1) {
        // Keep only what could still be the start of an element we want.
        buffer = final ? '' : buffer.slice(-16);
        return;
      }
      const isProgramme = first === progIdx;
      const closeTag = isProgramme ? '</programme>' : '</channel>';
      const openEnd = buffer.indexOf('>', first);
      if (openEnd === -1) {
        buffer = buffer.slice(first);
        return;
      }
      const openTag = buffer.slice(first, openEnd + 1);

      let blockEnd: number;
      if (openTag.endsWith('/>')) {
        blockEnd = openEnd + 1;
      } else {
        const close = findClose(buffer, openEnd, closeTag);
        if (close === -1) {
          buffer = buffer.slice(first);
          return;
        }
        blockEnd = close + closeTag.length - 1;
      }

      const block = buffer.slice(first, blockEnd + 1);
      buffer = buffer.slice(blockEnd + 1);

      if (isProgramme) {
        const programme = toProgramme(block, openTag, offset, language);
        if (programme && handlers.onProgramme) await handlers.onProgramme(programme);
      } else {
        const channel = toChannel(block, openTag);
        if (channel && handlers.onChannel) await handlers.onChannel(channel);
      }
    }
  };

  input.setEncoding('utf8');
  for await (const chunk of input) {
    buffer += chunk as string;
    await drain();
  }
  await drain(true);
}
