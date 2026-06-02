package media.fliks.app;

import android.Manifest;
import android.app.UiModeManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.Window;
import android.view.WindowManager;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private boolean immersiveMode = false;
    private boolean pipOnLeave = false;
    private boolean lightStatusBar = false;
    private android.app.PictureInPictureParams pipParams = null;
    private BroadcastReceiver pipActionReceiver;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(ImmersivePlugin.class);
        registerPlugin(PipPlugin.class);
        registerPlugin(HdrPlugin.class);
        registerPlugin(AudioCapabilitiesPlugin.class);
        registerPlugin(CastPlugin.class);
        registerPlugin(DownloadNotificationPlugin.class);
        registerPlugin(NativePlayerPlugin.class);
        super.onCreate(savedInstanceState);

        // Request notification permission (Android 13+)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this,
                    new String[]{ Manifest.permission.POST_NOTIFICATIONS }, 1001);
            }
        }

        // Tag the WebView UA when running on Android TV so the frontend can adapt its
        // layout (focus rings, larger fonts, no touch gestures, …). The frontend reads
        // this via the TvService and toggles a `tv` body class.
        if (isTvDevice() && getBridge() != null && getBridge().getWebView() != null) {
            android.webkit.WebSettings settings = getBridge().getWebView().getSettings();
            String ua = settings.getUserAgentString();
            if (ua != null && !ua.contains("AndroidTV")) {
                settings.setUserAgentString(ua + " AndroidTV/1");
            }
            // Required for the `<meta name="viewport" content="width=1280, …">` tag
            // we set in main.ts to actually take effect on the WebView. Without these
            // two, Android renders at device-width (often ~640 CSS px on TV with
            // high DPI) and Tailwind never reaches the lg breakpoint.
            settings.setUseWideViewPort(true);
            settings.setLoadWithOverviewMode(true);
            // The WebView must be focusable for D-pad key events to reach the JS
            // KeyboardEvent listeners. By default Capacitor's WebView is focusable,
            // but on TV some launchers strip focus on resume — re-assert it.
            android.webkit.WebView wv = getBridge().getWebView();
            wv.setFocusable(true);
            wv.setFocusableInTouchMode(true);
            wv.requestFocus();
        }

        applyEdgeToEdge();

        // Set initial status bar icon color — post to run after Capacitor setup
        getWindow().getDecorView().post(() -> setLightStatusBar(false));

        // PiP action receiver (play/pause button in PiP window)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            pipActionReceiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context context, Intent intent) {
                    String js = "window.dispatchEvent(new CustomEvent('pipAction', { detail: { action: 'togglePlayback' } }));";
                    getBridge().getWebView().evaluateJavascript(js, null);
                }
            };
            IntentFilter filter = new IntentFilter(PipPlugin.ACTION_TOGGLE_PLAYBACK);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(pipActionReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
            } else {
                registerReceiver(pipActionReceiver, filter);
            }
        }
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (pipActionReceiver != null) {
            try { unregisterReceiver(pipActionReceiver); } catch (Exception ignored) {}
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        // `singleTask` means the activity isn't recreated when the user
        // brings the app back from background — `onCreate` doesn't run
        // again, so the edge-to-edge flag needs to be re-asserted here
        // (some Android versions reset window flags on detach/attach
        // cycles). Also reapplies the status-bar icon color in case it
        // was reset alongside.
        applyEdgeToEdge();
        getWindow().getDecorView().post(this::applyLightStatusBar);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // The launch splash (and Capacitor bridge setup) keep the window in
        // the launch theme's opaque-bar state while they're up, so the
        // edge-to-edge call in onCreate — and even the first onResume, which
        // runs while the splash still covers the activity — don't stick: the
        // status bar only turns transparent once the window truly gains
        // focus after the splash is removed. That focus gain is exactly what
        // a recents → return cycle reproduces, which is why it "fixes itself"
        // there. Re-assert here so the first post-splash frame is edge-to-edge.
        if (hasFocus) {
            reapplyEdgeToEdge();
        }
    }

    /**
     * Asserts the window's edge-to-edge layout + transparent system
     * bars. Safe to call multiple times; idempotent.
     */
    private void applyEdgeToEdge() {
        Window window = getWindow();
        // Force the activity windowBackground to black so any moment where
        // the WebView is transparent (during native player playback, or
        // between routes when content briefly has transparent body bg)
        // doesn't flash the AppCompat.Light default white through the gap.
        window.setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(Color.BLACK));
        // Draw content edge-to-edge: required for `env(safe-area-inset-*)`
        // to report real values on Android ≤ 14. Android 15 (targetSdk 35)
        // applies the same opt-in automatically; calling it explicitly here
        // keeps the behaviour uniform across OS versions.
        WindowCompat.setDecorFitsSystemWindows(window, false);
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);
        // Draw into the display cutout on the short edges. In landscape the
        // punch-hole sits on a short (left/right) edge; the default mode
        // letterboxes it with a black bar. SHORT_EDGES lets the app background
        // reach the edge while body.native's env(safe-area-inset-left/right)
        // padding keeps content clear of the camera.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams lp = window.getAttributes();
            lp.layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            window.setAttributes(lp);
        }
        // Force a fresh window-insets dispatch down to the WebView. On a cold
        // start the bars are reset to opaque while the splash is up and the
        // insets that drive CSS env(safe-area-inset-*) arrive as zero, so the
        // top bar doesn't extend under the status bar (black strip) until the
        // next relayout. Requesting it explicitly re-publishes the real insets.
        window.getDecorView().requestApplyInsets();
    }

    /**
     * Re-asserts edge-to-edge + status-bar icon color. Used both on window
     * focus gain and from JS (ImmersivePlugin) right after the splash is
     * hidden — the first cold-start moment the layout is settled enough for
     * the transparent status bar + insets to actually stick. Marshals onto the
     * UI thread so it's safe to call from the plugin's binder thread too.
     */
    public void reapplyEdgeToEdge() {
        runOnUiThread(() -> {
            applyEdgeToEdge();
            getWindow().getDecorView().post(this::applyLightStatusBar);
        });
    }

    /** Called by ImmersivePlugin. */
    public void setImmersiveMode(boolean enabled) {
        this.immersiveMode = enabled;
    }

    /** Called by PipPlugin to enable/disable auto PiP on user leave. */
    public void setPipOnLeave(boolean enabled) {
        this.pipOnLeave = enabled;
    }

    /** Called by PipPlugin to store current params (with actions) for onUserLeaveHint. */
    public void updatePipParams(android.app.PictureInPictureParams params) {
        this.pipParams = params;
    }

    @Override
    public void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (pipOnLeave
                && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) {
            if (pipParams != null) {
                enterPictureInPictureMode(pipParams);
            } else {
                android.util.Rational aspectRatio = new android.util.Rational(16, 9);
                enterPictureInPictureMode(
                        new android.app.PictureInPictureParams.Builder()
                                .setAspectRatio(aspectRatio).build());
            }
        }
    }

    /** Set status/nav bar icon color: light=true means dark icons (for light theme). */
    public void setLightStatusBar(boolean light) {
        this.lightStatusBar = light;
        applyLightStatusBar();
    }

    private void applyLightStatusBar() {
        Window window = getWindow();
        WindowInsetsControllerCompat ic =
            WindowCompat.getInsetsController(window, window.getDecorView());
        ic.setAppearanceLightStatusBars(this.lightStatusBar);
        ic.setAppearanceLightNavigationBars(this.lightStatusBar);
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // An orientation change drops the edge-to-edge layout and the
        // WindowInsetsController appearance bits, so reassert both to keep the
        // status bar transparent with content drawn under it. Repeat on the
        // next frame because the insets that drive env(safe-area-inset-*) land
        // once the rotated layout has settled.
        reapplyEdgeToEdge();
        getWindow().getDecorView().post(this::reapplyEdgeToEdge);
    }

    /** True when the device is in television (leanback) UI mode. */
    private boolean isTvDevice() {
        UiModeManager m = (UiModeManager) getSystemService(Context.UI_MODE_SERVICE);
        return m != null && m.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION;
    }

    @Override
    public void onPictureInPictureModeChanged(boolean isInPipMode, Configuration newConfig) {
        super.onPictureInPictureModeChanged(isInPipMode, newConfig);
        // Notify the WebView so the frontend can hide/show controls
        String js = "window.dispatchEvent(new CustomEvent('pipModeChanged', { detail: { isInPipMode: " + isInPipMode + " } }));";
        getBridge().getWebView().evaluateJavascript(js, null);
    }
}
