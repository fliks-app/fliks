import { registerPlugin } from '@capacitor/core';

/** Android notification for the device this phone drives (a remote target). Its controls
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
    duration: number;
    canSetVolume: boolean;
    /** 0..1 */
    volume: number;
    muted: boolean;
    hasNext: boolean;
    /** Null hides the heart. */
    liked: boolean | null;
  }): Promise<void>;
  clear(): Promise<void>;
}

export type RemoteNotificationAction = 'play' | 'pause' | 'seek' | 'volume' | 'next' | 'stop' | 'like';

export const RemoteNotification = registerPlugin<RemoteNotificationPlugin>('RemoteNotification');
