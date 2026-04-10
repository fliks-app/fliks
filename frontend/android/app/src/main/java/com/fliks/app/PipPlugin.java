package com.fliks.app;

import android.app.PendingIntent;
import android.app.PictureInPictureParams;
import android.app.RemoteAction;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.util.Rational;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Collections;
import java.util.List;

/**
 * Capacitor plugin for native Android Picture-in-Picture.
 * HTML5 PiP (requestPictureInPicture) does not work in WebView —
 * this uses the Activity-level PiP API instead (API 26+).
 */
@CapacitorPlugin(name = "Pip")
public class PipPlugin extends Plugin {
    static final String ACTION_TOGGLE_PLAYBACK = "com.fliks.app.PIP_TOGGLE_PLAYBACK";
    private boolean autoEnterEnabled = false;
    private boolean isPlaying = false;

    @PluginMethod()
    public void enter(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            call.reject("PiP requires Android 8.0+");
            return;
        }
        if (!getActivity().getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) {
            call.reject("PiP not supported on this device");
            return;
        }

        PictureInPictureParams.Builder builder = new PictureInPictureParams.Builder()
                .setAspectRatio(new Rational(16, 9))
                .setActions(buildActions());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setSeamlessResizeEnabled(true);
        }

        boolean success = getActivity().enterPictureInPictureMode(builder.build());
        if (success) call.resolve();
        else call.reject("Failed to enter PiP");
    }

    @PluginMethod()
    public void setAutoEnter(PluginCall call) {
        autoEnterEnabled = call.getBoolean("enabled", false);
        ((MainActivity) getActivity()).setPipOnLeave(autoEnterEnabled);
        rebuildPipParams();
        call.resolve();
    }

    @PluginMethod()
    public void updatePlaybackState(PluginCall call) {
        isPlaying = call.getBoolean("playing", false);
        rebuildPipParams();
        call.resolve();
    }

    private void rebuildPipParams() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;

        PictureInPictureParams.Builder builder = new PictureInPictureParams.Builder()
                .setAspectRatio(new Rational(16, 9))
                .setActions(buildActions());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setAutoEnterEnabled(autoEnterEnabled);
            builder.setSeamlessResizeEnabled(true);
        }

        PictureInPictureParams params = builder.build();
        getActivity().setPictureInPictureParams(params);
        ((MainActivity) getActivity()).updatePipParams(params);
    }

    private List<RemoteAction> buildActions() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return Collections.emptyList();

        Intent intent = new Intent(ACTION_TOGGLE_PLAYBACK);
        intent.setPackage(getContext().getPackageName());
        PendingIntent pendingIntent = PendingIntent.getBroadcast(
                getContext(), 0, intent, PendingIntent.FLAG_IMMUTABLE);

        int iconRes = isPlaying ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play;
        Icon icon = Icon.createWithResource(getContext(), iconRes);
        String label = isPlaying ? "Pause" : "Play";
        RemoteAction action = new RemoteAction(icon, label, label, pendingIntent);

        return Collections.singletonList(action);
    }
}
