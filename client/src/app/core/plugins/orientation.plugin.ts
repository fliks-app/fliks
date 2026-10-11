import { registerPlugin } from '@capacitor/core';

interface OrientationPlugin {
  /** iOS only: freezes the orientation on screen. */
  lock(): Promise<void>;
  unlock(): Promise<void>;
  /** Phones only; tablets keep free rotation. */
  landscape(): Promise<void>;
}
export const Orientation = registerPlugin<OrientationPlugin>('Orientation');

/** Where a player's orientation rests when not frozen. */
export function releasePlayerOrientation(landscape: boolean): void {
  (landscape ? Orientation.landscape() : Orientation.unlock()).catch(() => {});
}
