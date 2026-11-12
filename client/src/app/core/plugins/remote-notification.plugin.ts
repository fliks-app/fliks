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
  /** iOS: this phone started the target, so the audio session may be taken back from the app that interrupted it. */
  resume(): Promise<void>;
}

export type RemoteNotificationAction = 'play' | 'pause' | 'seek' | 'volume' | 'next' | 'prev' | 'stop' | 'like';

export const RemoteNotification = registerPlugin<RemoteNotificationPlugin>('RemoteNotification');
