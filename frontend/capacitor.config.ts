import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'media.fliks.app',
  appName: 'Fliks',
  webDir: 'dist/frontend/browser',
  server: {
    androidScheme: 'http',
  },
  // Page en https://localhost + API en http://<LAN>:3001 → sinon blocage Mixed Content.
  android: {
    allowMixedContent: true,
  },
  ios: {
    allowMixedContent: true,
    webContentsDebuggingEnabled: true,
  },
};

export default config;
