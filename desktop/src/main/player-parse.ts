import type {
  DesktopLoadOptions,
  DesktopMuteRange,
  DesktopSubtitleStyle,
} from '../shared/contract';
import { bool, nullable, num, obj, str } from './ipc-parse.ts';

const optional = <T>(v: unknown, parse: (v: unknown) => T): T | undefined => (v == null ? undefined : parse(v));

export function parseLoadOptions(v: unknown): DesktopLoadOptions {
  const o = obj(v);
  const headers = optional(o.headers, (h) =>
    Object.fromEntries(Object.entries(obj(h)).map(([k, val]) => [str(k, 256), str(val, 8192)])),
  );
  return {
    url: str(o.url, 8192),
    startTime: optional(o.startTime, num),
    startPaused: optional(o.startPaused, bool),
    headers,
    audioLanguage: optional(o.audioLanguage, (l) => str(l, 64)),
    videoCrop: optional(o.videoCrop, (c) => str(c, 64)),
  };
}

export function parseMuteRanges(v: unknown): DesktopMuteRange[] {
  if (!Array.isArray(v) || v.length > 10_000) throw new Error('invalid ranges');
  return v.map((r) => {
    const o = obj(r);
    return { start: num(o.start), end: num(o.end) };
  });
}

export function parseSubtitleStyle(v: unknown): DesktopSubtitleStyle {
  const o = obj(v);
  return {
    fontScale: num(o.fontScale),
    foregroundColor: str(o.foregroundColor, 64),
    backgroundColor: str(o.backgroundColor, 64),
    edgeType: optional(o.edgeType, (e) => str(e, 64)),
    bottomMarginPercent: num(o.bottomMarginPercent),
    topMarginPercent: optional(o.topMarginPercent, num),
  };
}

export const parseTrackId = nullable((v) => str(v, 64));
