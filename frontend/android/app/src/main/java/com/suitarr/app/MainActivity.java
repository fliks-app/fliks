package com.suitarr.app;

import android.content.res.Configuration;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(ImmersivePlugin.class);
        registerPlugin(PipPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onPictureInPictureModeChanged(boolean isInPipMode, Configuration newConfig) {
        super.onPictureInPictureModeChanged(isInPipMode, newConfig);
        // Notify the WebView so the frontend can hide/show controls
        String js = "window.dispatchEvent(new CustomEvent('pipModeChanged', { detail: { isInPipMode: " + isInPipMode + " } }));";
        getBridge().getWebView().evaluateJavascript(js, null);
    }
}
