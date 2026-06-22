import type { DesktopAudioTrack, DesktopSubtitleTrack } from '../../shared/contract';

interface MpvTrack {
  id: number;
  type: string;
  codec?: string;
  lang?: string;
  title?: string;
  selected?: boolean;
  forced?: boolean;
}

/** Bitmap subtitle codecs (PGS / VOBSUB / DVB / XSUB) carry rendered images,
 *  not text. mpv would render them as burned-in overlays; they're handled by
 *  server-side burn-in/OCR, never as selectable tracks. Mirrors
 *  isImageBasedSubtitleCodec on the web/android clients. */
const IMAGE_BASED_SUBTITLE_CODECS = new Set([
  'hdmv_pgs_subtitle',
  'dvd_subtitle',
  'dvb_subtitle',
  'xsub',
]);

export function isImageBasedSubtitleCodec(codec: string | undefined): boolean {
  return IMAGE_BASED_SUBTITLE_CODECS.has(codec ?? '');
}

/** Parse mpv's `track-list` JSON (as returned by get_property_string) into the
 *  desktop contract's audio/subtitle shapes. Shared by every libmpv backend
 *  that reads tracks via a property string (the Linux compositor and the macOS
 *  in-process player). Tolerates a null/partial value (returns empty lists). */
export function parseTracks(json: string | null): {
  audioTracks: DesktopAudioTrack[];
  subtitleTracks: DesktopSubtitleTrack[];
} {
  let list: MpvTrack[] = [];
  try {
    list = JSON.parse(json ?? '[]') ?? [];
  } catch {
    /* not ready */
  }
  const audioTracks: DesktopAudioTrack[] = [];
  const subtitleTracks: DesktopSubtitleTrack[] = [];
  for (const t of list) {
    if (t.type === 'audio')
      audioTracks.push({
        id: String(t.id),
        language: t.lang ?? '',
        label: t.title ?? '',
        selected: !!t.selected,
      });
    else if (t.type === 'sub' && !isImageBasedSubtitleCodec(t.codec))
      subtitleTracks.push({
        id: String(t.id),
        language: t.lang ?? '',
        label: t.title ?? '',
        forced: !!t.forced,
        selected: !!t.selected,
      });
  }
  return { audioTracks, subtitleTracks };
}
