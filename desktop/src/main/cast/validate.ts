import type { DesktopCastLoadOptions, DesktopCastTextTrackStyle } from '../../shared/contract.ts';
import { bool, num, obj, str } from '../ipc-parse.ts';

const MAX_SUBTITLES = 200;

export function parseTextTrackStyle(v: unknown): DesktopCastTextTrackStyle {
  const o = obj(v);
  return {
    fontGenericFamily: str(o.fontGenericFamily, 100),
    fontScale: num(o.fontScale),
    foregroundColor: str(o.foregroundColor, 100),
    backgroundColor: str(o.backgroundColor, 100),
    edgeType: str(o.edgeType, 100),
    edgeColor: str(o.edgeColor, 100),
    customData: { bottomMargin: num(obj(o.customData).bottomMargin) },
  };
}

/** Rebuilds the renderer's LOAD options field by field; `customData` is forwarded as an object. */
export function parseLoadOptions(v: unknown): DesktopCastLoadOptions {
  const o = obj(v);
  if (!Array.isArray(o.subtitles) || o.subtitles.length > MAX_SUBTITLES) throw new Error('invalid subtitles');
  return {
    url: str(o.url, 8192),
    contentType: str(o.contentType, 200),
    title: str(o.title, 1000),
    subtitle: str(o.subtitle, 1000),
    posterUrl: str(o.posterUrl, 8192),
    currentTime: num(o.currentTime),
    autoplay: bool(o.autoplay),
    subtitles: o.subtitles.map((s) => {
      const t = obj(s);
      return { url: str(t.url, 8192), language: str(t.language, 100), label: str(t.label, 1000) };
    }),
    activeSubtitleTrackId: num(o.activeSubtitleTrackId),
    ...(o.customData != null ? { customData: obj(o.customData) } : {}),
    ...(o.castTextTrackStyle != null ? { castTextTrackStyle: parseTextTrackStyle(o.castTextTrackStyle) } : {}),
  };
}
