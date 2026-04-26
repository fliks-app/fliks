package media.fliks.app;

import android.Manifest;
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

        Window window = getWindow();
        // Transparent system bars — CSS env(safe-area-inset-*) handles the offset
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);

        // Set initial status bar icon color — post to run after Capacitor setup
        window.getDecorView().post(() -> setLightStatusBar(false));

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

    @Override
    public void onPictureInPictureModeChanged(boolean isInPipMode, Configuration newConfig) {
        super.onPictureInPictureModeChanged(isInPipMode, newConfig);
        // Notify the WebView so the frontend can hide/show controls
        String js = "window.dispatchEvent(new CustomEvent('pipModeChanged', { detail: { isInPipMode: " + isInPipMode + " } }));";
        getBridge().getWebView().evaluateJavascript(js, null);
    }
}
