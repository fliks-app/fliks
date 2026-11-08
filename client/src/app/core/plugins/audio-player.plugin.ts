import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { InjectionToken } from '@angular/core';
import type { MusicTrackRequest } from '../services/audio-player/music-queue';
import type { ReplayGainMode } from '../services/audio-player/replay-gain';

export interface NativeAudioState {
  playing: boolean;
  playWhenReady: boolean;
  buffering: boolean;
  ready: boolean;
  ended: boolean;
}

export interface NativeAudioPosition {
  /** Queue entry (a part of an audiobook) the position is in. */
  index: number;
  /** Seconds in that entry. */
  position: number;
  duration: number;
}

export interface NativeAudioTrack {
  index: number;
  itemId?: number;
  mediaFileId?: number;
  sessionId?: string;
}

/** A track queue the native side built itself (Android Auto, a headset). */
export interface NativeAudioQueue {
  tracks: MusicTrackRequest[];
  index: number;
}

/** A transport control used outside the app while a party drives the audio. */
export interface NativeAudioCommand {
  command: 'play' | 'pause' | 'next' | 'previous' | 'seek';
  value: number;
}

export interface NativeAudioPart {
  url: string;
}

export interface AudioPlayerPlugin {
  /** The device profile native code sends to resolve a track's stream. */
  configure(o: { deviceProfile: string }): Promise<void>;
  /** The web layer observes the player: it beats progress and refreshes tokens. */
  attach(): Promise<void>;
  detach(): Promise<void>;
  /** Tracks are named by item; the native side resolves each stream when it loads. */
  setQueue(o: { tracks: MusicTrackRequest[]; index: number; startAt?: number; autoplay: boolean }): Promise<void>;
  /** Replaces the order around the current entry, which stays at `index`. */
  updateQueue(o: { tracks: MusicTrackRequest[]; index: number }): Promise<void>;
  loadParts(o: {
    parts: NativeAudioPart[];
    index: number;
    startAt: number;
    autoplay: boolean;
    rate: number;
    title: string;
    artist?: string;
    album?: string;
    artworkUrl?: string | null;
  }): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(o: { position: number; index?: number }): Promise<void>;
  skipTo(o: { index: number }): Promise<void>;
  setRate(o: { rate: number }): Promise<void>;
  setGain(o: { mode: ReplayGainMode; preamp: number; duck: number }): Promise<void>;
  setRepeat(o: { mode: 'off' | 'all' | 'one' }): Promise<void>;
  /** While true, controls outside the app come back as `command` events and do nothing natively. */
  setRouted(o: { routed: boolean }): Promise<void>;
  stop(): Promise<void>;
  addListener(event: 'state', fn: (e: NativeAudioState) => void): Promise<PluginListenerHandle>;
  addListener(event: 'position', fn: (e: NativeAudioPosition) => void): Promise<PluginListenerHandle>;
  addListener(event: 'track', fn: (e: NativeAudioTrack) => void): Promise<PluginListenerHandle>;
  addListener(event: 'queue', fn: (e: NativeAudioQueue) => void): Promise<PluginListenerHandle>;
  addListener(event: 'command', fn: (e: NativeAudioCommand) => void): Promise<PluginListenerHandle>;
  addListener(event: 'error', fn: (e: { message: string }) => void): Promise<PluginListenerHandle>;
}

const AudioPlayer = registerPlugin<AudioPlayerPlugin>('AudioPlayer');

/** The native audio player on Capacitor, null elsewhere. */
export const NATIVE_AUDIO = new InjectionToken<AudioPlayerPlugin | null>('NATIVE_AUDIO', {
  providedIn: 'root',
  factory: () => (Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('AudioPlayer') ? AudioPlayer : null),
});
