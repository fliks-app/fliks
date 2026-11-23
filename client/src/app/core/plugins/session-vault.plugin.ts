import { registerPlugin } from '@capacitor/core';

/** iOS Keychain store for the signed-in sessions blob. */
interface SessionVaultPlugin {
  get(options: { key: string }): Promise<{ value?: string }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
}
export const SessionVault = registerPlugin<SessionVaultPlugin>('SessionVault');
