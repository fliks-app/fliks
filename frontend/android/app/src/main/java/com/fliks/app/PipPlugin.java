package com.fliks.app;

import android.app.PictureInPictureParams;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Rational;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Capacitor plugin for native Android Picture-in-Picture.
 * HTML5 PiP (requestPictureInPicture) does not work in WebView —
 * this uses the Activity-level PiP API instead (API 26+).
 */
@CapacitorPlugin(name = "Pip")
public class PipPlugin extends Plugin {

    @PluginMethod()
    public void enter(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            call.reject("PiP requires Android 8.0+");
            return;
        }

        var activity = getActivity();
        if (!activity.getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) {
            call.reject("PiP not supported on this device");
            return;
        }

        Rational aspectRatio = new Rational(16, 9);
        PictureInPictureParams.Builder params = new PictureInPictureParams.Builder()
                .setAspectRatio(aspectRatio);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            params.setSeamlessResizeEnabled(true);
        }

        boolean success = activity.enterPictureInPictureMode(params.build());
        if (success) {
            call.resolve();
        } else {
            call.reject("Failed to enter PiP");
        }
    }

    @PluginMethod()
    public void setAutoEnter(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            boolean enabled = call.getBoolean("enabled", false);
            Rational aspectRatio = new Rational(16, 9);
            PictureInPictureParams params = new PictureInPictureParams.Builder()
                    .setAspectRatio(aspectRatio)
                    .setAutoEnterEnabled(enabled)
                    .build();
            getActivity().setPictureInPictureParams(params);
        }
        call.resolve();
    }
}
