const DEFAULT_DURATION_MIN = 2 * 60;
const FOLD_OCTETS = 75;
const encoder = new TextEncoder();

export interface PartyIcsInput {
  id: number;
  name: string;
  startsAt: Date;
  /** Media runtime in minutes; absent or non-positive means unknown. */
  runtimeMin?: number | null;
  link: string;
  now?: Date;
}

/** RFC 5545 TEXT escaping. */
export function escapeIcsText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
}

/** `YYYYMMDDTHHMMSSZ`. */
export function icsUtc(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Folds a content line at 75 octets, never inside a UTF-8 sequence; continuations start with a space. */
export function foldIcsLine(line: string): string {
  const out: string[] = [];
  let cur = '';
  let octets = 0;
  for (const ch of line) {
    const n = encoder.encode(ch).length;
    if (octets + n > FOLD_OCTETS) {
      out.push(cur);
      cur = ' ';
      octets = 1;
    }
    cur += ch;
    octets += n;
  }
  out.push(cur);
  return out.join('\r\n');
}

function duration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `PT${h ? `${h}H` : ''}${m || !h ? `${m}M` : ''}`;
}

export function buildPartyIcs(p: PartyIcsInput): string {
  const runtime = p.runtimeMin && p.runtimeMin > 0 ? Math.round(p.runtimeMin) : DEFAULT_DURATION_MIN;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Fliks//Watch party//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:party-${p.id}@fliks`,
    `DTSTAMP:${icsUtc(p.now ?? new Date())}`,
    `DTSTART:${icsUtc(p.startsAt)}`,
    `DURATION:${duration(runtime)}`,
    `SUMMARY:${escapeIcsText(p.name)}`,
    `DESCRIPTION:${escapeIcsText(p.link)}`,
    `URL:${p.link}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${escapeIcsText(p.name)}`,
    'TRIGGER:-PT15M',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(foldIcsLine).join('\r\n') + '\r\n';
}
