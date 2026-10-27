import { registerPlugin } from '@capacitor/core';

interface ImmersivePlugin {
  enter(options?: { displayBehindNotch?: boolean }): Promise<void>;
  exit(): Promise<void>;
  setLightStatusBar(options: { light: boolean }): Promise<void>;
  setKeyboardOverlay(options: { enabled: boolean }): Promise<void>;
  applyEdgeToEdge(): Promise<void>;
}
export const Immersive = registerPlugin<ImmersivePlugin>('Immersive');
