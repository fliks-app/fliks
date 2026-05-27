import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface ActiveStream {
  sessionId: string;
  userId: number | null;
  username: string | null;
  mediaId: number;
  mediaFileId: number;
  mediaTitle: string;
  mediaType: string;
  episodeId: number | null;
  episodeLabel: string | null;
  posterUrl: string | null;
  mode: 'transcode' | 'remux' | 'directplay';
  quality: string;
  hwAccel: string;
  device: string | null;
  startedAt: string;
  lastActivity: string;
  positionSeconds: number;
  durationSeconds: number;
  container: string | null;
  videoCodec: string | null;
  videoResolution: string | null;
  videoBitrate: number | null;
  audioCodec: string | null;
  audioChannels: string | null;
  audioLanguage: string | null;
  outputContainer: string | null;
  outputBitrate: number | null;
  videoPlaybackMode: string;
  /** Real audio output codec emitted by ffmpeg (e.g. `'aac'`, `'ac3'`).
   *  `null` when audio is direct-played / copy-remuxed without transcode. */
  audioOutputCodec: string | null;
  audioOutputBitrateBps: number | null;
  /** `'direct'` = source file served as-is; `'copy'` = container changed
   *  but audio bitstream verbatim; `'transcode'` = ffmpeg re-encoded. */
  audioMode: 'direct' | 'copy' | 'transcode';
  transcodePercent: number | null;
  videoReasons: string[];
  audioReasons: string[];
  containerReasons: string[];
}

@Injectable({ providedIn: 'root' })
export class StreamsApiService {
  private readonly http = inject(HttpClient);

  list() {
    return firstValueFrom(
      this.http.get<ActiveStream[]>('/api/system/streams'),
    );
  }

  kill(sessionId: string) {
    return firstValueFrom(
      this.http.delete<void>(`/api/system/streams/${sessionId}`),
    );
  }

  sendCommand(
    sessionId: string,
    action: 'pause' | 'play' | 'stop' | 'message',
    message?: string,
  ) {
    return firstValueFrom(
      this.http.post<void>(`/api/system/streams/${sessionId}/command`, {
        action,
        message,
      }),
    );
  }
}
