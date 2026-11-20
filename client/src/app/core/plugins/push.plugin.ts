import { registerPlugin } from '@capacitor/core';

export type PushPermission = 'granted' | 'denied' | 'prompt';

/** Native push of the mobile apps (APNs and FCM through the relay). Absent on the web, where `PushService` uses the service worker. */
export interface PushPlugin {
  /** `available: false` without Google Play services, on TV and in a build without Firebase config. */
  status(): Promise<{ available: boolean; permission: PushPermission }>;
  /** Shows the system dialog when the permission is still undetermined; never at launch, only from `PushService`. */
  requestPermission(): Promise<{ permission: PushPermission }>;
  /** The app's notification page of the system settings, where a refused permission is given back. */
  openSettings(): Promise<void>;
  /** Rejects unless the permission is granted, and returns this session's public key material. `session` is `SessionRef.key`. */
  prepare(options: { session: string }): Promise<{ platform: 'apns' | 'fcm'; p256dh: string; auth: string }>;
  /** Registers the platform token at the relay with the ticket the server issued; the token never reaches the web layer. */
  subscribe(options: { session: string; sub: string; ticket: string; serverUrl: string }): Promise<void>;
  /** Deletes the subscription at the relay and erases its key once the relay confirmed; pending deletions are retried at launch. */
  unsubscribe(options: { session: string }): Promise<void>;
  setBadge(options: { count: number }): Promise<void>;
  addListener(event: 'pushOpened', listener: (e: PushOpened) => void): Promise<{ remove: () => Promise<void> }>;
}

/** A notification the user tapped. `session` is absent when the sender did not name one. */
export interface PushOpened {
  session?: SessionRef;
  url: string;
}

export interface SessionRef {
  serverUrl: string;
  userId: number;
  /** `serverUrl|userId`, the key the native side stores a subscription under. */
  key: string;
}

export const Push = registerPlugin<PushPlugin>('Push');
