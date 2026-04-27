import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'media.fliks.app',
  appName: 'Fliks',
  webDir: 'dist/frontend/browser',
  server: {
    androidScheme: 'http',
  },
  // WebView background painted by Capacitor's Bridge during init, BEFORE the
  // WebView starts loading any HTML — this is the only path that reliably
  // kills the default-white frame between the native splash and the first
  // Angular paint. Single colour (navy = Fliks brand); light-theme users see
  // navy briefly between splash and daisyUI applying white, same as today's
  // OS-painted cold-start splash.
  backgroundColor: '#1d232a',
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
