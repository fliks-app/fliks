import { registerPlugin } from '@capacitor/core';

/** Android notification / iOS lock screen for the device this phone drives (a remote target). Its controls
 *  arrive as `remoteNotificationCommand` window events. */
export interface RemoteNotificationPlugin {
  update(options: {
    title: string;
    artist?: string;
    artworkUrl?: string;
    playing: boolean;
    buffering: boolean;
    /** Seconds. */
    position: number;
    /** Epoch ms of the report, so native can tell a report older than its last local seek. */
    sentAt: number;
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
  }): Promise<void>;
  clear(): Promise<void>;
}

export type RemoteNotificationAction = 'play' | 'pause' | 'seek' | 'volume' | 'next' | 'stop' | 'like';

export const RemoteNotification = registerPlugin<RemoteNotificationPlugin>('RemoteNotification');
