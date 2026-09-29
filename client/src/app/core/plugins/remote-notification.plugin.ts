import { registerPlugin } from '@capacitor/core';

/** Notification for the device this phone drives (a remote target): a media notification on
 *  Android, a Live Activity on iOS. Its controls arrive as `remoteNotificationCommand` window
 *  events. */
export interface RemoteNotificationPlugin {
  update(options: {
    title: string;
    artist?: string;
    artworkUrl?: string;
    playing: boolean;
    buffering: boolean;
    /** Seconds. */
    position: number;
    duration: number;
    canSetVolume: boolean;
    /** 0..1 */
    volume: number;
    muted: boolean;
    hasNext: boolean;
    /** Null hides the heart. */
    liked: boolean | null;
    /** ±10 s instead of previous/next. */
    seekButtons: boolean;
    /** iOS only. The Live Activity sends its commands natively, the WebView being suspended in
     *  the background, so it needs the connection. Held in memory, never persisted. */
    serverUrl?: string;
    accessToken?: string;
    targetId?: string;
    /** This phone's own target id, as the server expects it on a command. */
    byTargetId?: string;
    mediaId?: number;
    episodeId?: number;
    /** iOS only. Small poster: the activity carries a few hundred bytes of artwork at most. */
    thumbnailUrl?: string;
    /** iOS only. Pre-translated: an activity cannot reach ngx-translate. */
    deviceName?: string;
    staleLabel?: string;
  }): Promise<void>;
  clear(): Promise<void>;
}

/** `sent` (iOS): the command already went out natively, so only the local state needs to follow. */
export interface RemoteNotificationCommand {
  action: RemoteNotificationAction;
  value: number;
  sent?: boolean;
}

export type RemoteNotificationAction = 'play' | 'pause' | 'seek' | 'volume' | 'next' | 'stop' | 'like';

export const RemoteNotification = registerPlugin<RemoteNotificationPlugin>('RemoteNotification');
