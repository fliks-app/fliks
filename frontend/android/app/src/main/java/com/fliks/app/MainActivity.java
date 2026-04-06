package com.fliks.app;

import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Window;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private boolean immersiveMode = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(ImmersivePlugin.class);
        registerPlugin(PipPlugin.class);
        registerPlugin(HdrPlugin.class);
        registerPlugin(CastPlugin.class);
        super.onCreate(savedInstanceState);

        Window window = getWindow();
        // Transparent system bars — CSS env(safe-area-inset-*) handles the offset
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);

        // Set initial status bar icon color — post to run after Capacitor setup
        window.getDecorView().post(() -> setLightStatusBar(false));

    }

    /** Called by ImmersivePlugin. */
    public void setImmersiveMode(boolean enabled) {
        this.immersiveMode = enabled;
    }

    /** Set status/nav bar icon color: light=true means dark icons (for light theme). */
    public void setLightStatusBar(boolean light) {
        Window window = getWindow();
        WindowInsetsControllerCompat ic =
            WindowCompat.getInsetsController(window, window.getDecorView());
        ic.setAppearanceLightStatusBars(light);
        ic.setAppearanceLightNavigationBars(light);
    }

    @Override
    public void onPictureInPictureModeChanged(boolean isInPipMode, Configuration newConfig) {
        super.onPictureInPictureModeChanged(isInPipMode, newConfig);
        // Notify the WebView so the frontend can hide/show controls
        String js = "window.dispatchEvent(new CustomEvent('pipModeChanged', { detail: { isInPipMode: " + isInPipMode + " } }));";
        getBridge().getWebView().evaluateJavascript(js, null);
    }
}
