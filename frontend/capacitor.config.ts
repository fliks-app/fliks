import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.suitarr.app',
  appName: 'Suitarr',
  webDir: 'dist/frontend/browser',
  server: {
    androidScheme: 'https',
  },
  // Page en https://localhost + API en http://<LAN>:3001 → sinon blocage Mixed Content.
  android: {
    allowMixedContent: true,
  },
};

export default config;
