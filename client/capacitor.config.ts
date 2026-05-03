import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'media.fliks.app',
  appName: 'Fliks',
  webDir: 'dist/client/browser',
  // Capacitor logs every plugin call (call + result, so 2 lines each). Our
  // 1Hz NativePlayer.getPosition poll for the seekbar floods the devtools
  // console with hundreds of lines per minute, drowning out our own logs.
  // 'none' silences the bridge chatter; our app code still uses console.*
  // directly for diagnostics.
  loggingBehavior: 'none',
  server: {
    androidScheme: 'http',
  },
  // WebView background painted by Capacitor's Bridge during init, BEFORE the
  // WebView starts loading any HTML — kills the default-white frame between
  // the native splash and the first Angular paint. Single colour (navy =
  // Fliks brand). Combined with the SplashScreen plugin below, the user
  // never sees the WebView white default at all.
  backgroundColor: '#1d232a',
  plugins: {
    // Keep the native splash visible until Angular calls SplashScreen.hide()
    // (after first navigation completes). Without this, the splash dismisses
    // on Activity ready and the WebView's still-loading state leaks through
    // as a flash. launchAutoHide:false is the key flag — the rest is style.
    SplashScreen: {
      launchAutoHide: false,
      backgroundColor: '#1d232a',
      androidSplashResourceName: 'splash_themed',
      // CENTER (not CENTER_CROP) keeps the splash drawable at its native
      // pixel size and centred over the navy background. CENTER_CROP
      // scaled the brand mark up to fill the entire TV screen on large
      // displays — way oversized. With CENTER the mark stays at its
      // designed size on phones, tablets, and TVs alike.
      androidScaleType: 'CENTER',
      splashFullScreen: true,
      splashImmersive: true,
    },
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
