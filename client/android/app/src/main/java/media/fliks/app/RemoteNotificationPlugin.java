package media.fliks.app;

import android.net.Uri;
import android.os.Handler;
import android.os.Looper;

import androidx.media3.common.MediaMetadata;
import androidx.media3.session.MediaSession;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** The notification of the device this phone remote-controls. Controls come back
 *  as `remoteNotificationCommand` window events: {action, value}. */
@CapacitorPlugin(name = "RemoteNotification")
public class RemoteNotificationPlugin extends Plugin {
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private RemoteStatePlayer player;
    private MediaSession session;

    @PluginMethod()
    public void update(PluginCall call) {
        String artwork = call.getString("artworkUrl");
        MediaMetadata metadata = new MediaMetadata.Builder()
                .setTitle(call.getString("title", ""))
                .setArtist(call.getString("artist", ""))
                .setArtworkUri(artwork != null ? Uri.parse(artwork) : null)
                .build();
        boolean playing = call.getBoolean("playing", false);
        boolean buffering = call.getBoolean("buffering", false);
        long positionMs = (long) (call.getDouble("position", 0.0) * 1000);
        long durationMs = (long) (call.getDouble("duration", 0.0) * 1000);
        boolean canSetVolume = call.getBoolean("canSetVolume", false);
        int volume = (int) Math.round(call.getDouble("volume", 1.0) * 100);
        boolean muted = call.getBoolean("muted", false);
        boolean hasNext = call.getBoolean("hasNext", false);
        mainHandler.post(() -> {
            if (session == null) {
                player = new RemoteStatePlayer(Looper.getMainLooper(), (action, value) -> emit(action, value));
                session = QueueSession.build(getContext(), player, "remote",
                        () -> emit("seek", 0), () -> emit("next", 0));
                PlaybackService.attach(getContext(), session);
            }
            player.update(metadata, playing, buffering, positionMs, durationMs, canSetVolume, volume, muted);
            QueueSession.setHasNext(getContext(), session, hasNext);
            call.resolve();
        });
    }

    @PluginMethod()
    public void clear(PluginCall call) {
        mainHandler.post(() -> {
            release();
            call.resolve();
        });
    }

    @Override
    protected void handleOnDestroy() {
        release();
    }

    private void release() {
        if (session == null) return;
        PlaybackService.detach(getContext(), session);
        session.release();
        player.release();
        session = null;
        player = null;
    }

    private void emit(String action, double value) {
        JSObject detail = new JSObject();
        detail.put("action", action);
        detail.put("value", value);
        getBridge().getWebView().evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('remoteNotificationCommand',{detail:" + detail + "}));", null);
    }
}
