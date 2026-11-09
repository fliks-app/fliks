import type { DirectPlayProfile } from './browser-device-profile.service';

/** A MIME the audio element may open, in the server's vocabulary: containers by file extension or ffprobe format name, codecs by ffprobe name. */
const AUDIO_FORMATS: ReadonlyArray<{ mime: string; containers: string[]; codecs: string[] }> = [
  { mime: 'audio/mpeg', containers: ['mp3'], codecs: ['mp3'] },
  { mime: 'audio/aac', containers: ['aac'], codecs: ['aac'] },
  { mime: 'audio/mp4; codecs="mp4a.40.2"', containers: ['m4a', 'mp4'], codecs: ['aac'] },
  { mime: 'audio/mp4; codecs="alac"', containers: ['m4a', 'mp4'], codecs: ['alac'] },
  { mime: 'audio/flac', containers: ['flac'], codecs: ['flac'] },
  { mime: 'audio/ogg; codecs="vorbis"', containers: ['ogg'], codecs: ['vorbis'] },
  { mime: 'audio/ogg; codecs="opus"', containers: ['ogg', 'opus'], codecs: ['opus'] },
  { mime: 'audio/wav; codecs="1"', containers: ['wav'], codecs: ['pcm_s16le', 'pcm_s24le'] },
];

/** The formats the element reports it can open, minus the `denied` MIMEs; Direct Play opens the file with `src`, so `canPlayType` is the probe, not MSE. */
export function probeAudioDirectPlay(
  el: Pick<HTMLMediaElement, 'canPlayType'>,
  denied: ReadonlySet<string> = new Set(),
): DirectPlayProfile {
  const playable = AUDIO_FORMATS.filter((f) => !denied.has(f.mime) && !!el.canPlayType(f.mime));
  const union = (pick: (f: (typeof AUDIO_FORMATS)[number]) => string[]) => [...new Set(playable.flatMap(pick))];
  return { containers: union((f) => f.containers), videoCodecs: [], audioCodecs: union((f) => f.codecs) };
}

/** The MIMEs `mediaCapabilities` says cannot be decoded; empty where the API is missing, so `canPlayType` alone decides. */
export async function undecodableAudioFormats(): Promise<Set<string>> {
  const caps = typeof navigator === 'undefined' ? undefined : navigator.mediaCapabilities;
  const denied = new Set<string>();
  if (!caps?.decodingInfo) return denied;
  await Promise.all(
    AUDIO_FORMATS.map(async ({ mime }) => {
      try {
        const r = await caps.decodingInfo({ type: 'file', audio: { contentType: mime } });
        if (!r.supported) denied.add(mime);
      } catch {
        // The engine does not know the type: canPlayType stays the verdict.
      }
    }),
  );
  return denied;
}
