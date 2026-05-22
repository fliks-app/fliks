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
        // cycles). Post to the decor view's queue so the call lands
        // after the system has finished restoring its own window state
        // on resume — calling it inline raced with Android 13's async
        // bar reset and missed roughly 1 in 3 returns from background.
        getWindow().getDecorView().post(() -> {
            applyEdgeToEdge();
            applyLightStatusBar();
        });
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // Belt-and-braces: when the system finishes the return-from-
        // recents animation it dispatches a focus-gained that lands
        // strictly after any internal flag reset. Re-asserting here
        // catches the cases where onResume fired too early to stick.
        if (hasFocus) {
            getWindow().getDecorView().post(() -> {
                applyEdgeToEdge();
                applyLightStatusBar();
            });
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
        // Android resets the WindowInsetsController appearance bits on orientation
        // changes; reapply the last requested state so nav/status icons keep their
        // theme-matching color (white on dark, dark on light).
        getWindow().getDecorView().post(this::applyLightStatusBar);
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
