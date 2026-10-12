import type { DesktopAudioTrack, DesktopSubtitleTrack } from '../../shared/contract';

/** A single entry of mpv's `track-list`. Shared by every backend: the Windows
 *  subprocess reads it as parsed JSON-IPC data, the libmpv addons via a property
 *  string. */
export interface MpvTrack {
  id: number;
  type: string;
  codec?: string;
  lang?: string;
  title?: string;
  selected?: boolean;
  forced?: boolean;
  /** Container stream index (the ffprobe index), absent on non-lavf tracks. */
  'ff-index'?: number;
  external?: boolean;
  /** Source a sidecar was loaded from, verbatim as passed to `sub-add`. */
  'external-filename'?: string;
}

/** Bitmap subtitle codecs (PGS / VOBSUB / DVB / XSUB) carry rendered images,
 *  not text. mpv renders them natively, so they stay selectable tracks, flagged
 *  so the client can tell them apart. Mirrors isImageBasedSubtitleCodec on the
 *  web/android clients. */
const IMAGE_BASED_SUBTITLE_CODECS = new Set([
  'hdmv_pgs_subtitle',
  'dvd_subtitle',
  'dvb_subtitle',
  'xsub',
]);

export function isImageBasedSubtitleCodec(codec: string | undefined): boolean {
  return IMAGE_BASED_SUBTITLE_CODECS.has(codec ?? '');
}

/** Map an mpv `track-list` array into the desktop contract's audio/subtitle
 *  shapes. The single source of truth for track mapping across all three backends. */
export function mapTrackList(list: MpvTrack[]): {
  audioTracks: DesktopAudioTrack[];
  subtitleTracks: DesktopSubtitleTrack[];
} {
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
    else if (t.type === 'sub')
      subtitleTracks.push({
        id: String(t.id),
        language: t.lang ?? '',
        label: t.title ?? '',
        forced: !!t.forced,
        selected: !!t.selected,
        image: isImageBasedSubtitleCodec(t.codec),
        external: !!t.external,
        source: t.external ? (t['external-filename'] ?? null) : null,
        ffIndex: t.external ? null : (t['ff-index'] ?? null),
      });
  }
  return { audioTracks, subtitleTracks };
}

/** Parse mpv's `track-list` JSON (as returned by get_property_string) and map
 *  it. Used by the libmpv addons (Linux compositor, macOS in-process) that read
 *  tracks via a property string. Tolerates a null/partial value (empty lists). */
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
  return mapTrackList(list);
}
