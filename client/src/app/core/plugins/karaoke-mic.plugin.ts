import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

interface KaraokeMicPlugin {
  /** Rejects with `denied` when the microphone permission is refused. */
  start(): Promise<{ sampleRate: number; echoCancelled: boolean }>;
  stop(): Promise<void>;
  /** Mono samples as little-endian 16-bit PCM, base64. */
  addListener(event: 'block', cb: (e: { data: string }) => void): Promise<PluginListenerHandle>;
}
export const KaraokeMic = registerPlugin<KaraokeMicPlugin>('KaraokeMic');
