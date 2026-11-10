package media.fliks.app;

import android.app.UiModeManager;
import android.content.Context;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.provider.Settings;

import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.function.Consumer;

/** The native player as a remote target while its web layer cannot take commands: a polled target
 *  (`remote.md` rule 21a) registered under the device id, whose queue it polls. */
final class NativeFace {
    private final Context context;
    private final FliksApi api;
    private final ExecutorService io;
    private final Handler main;
    private final Consumer<JSONObject> sink;
    /** Guarded by `this`: a registration and a departure never interleave. */
    private volatile boolean registered;
    private volatile boolean wanted;
    private volatile boolean polling;

    NativeFace(Context context, FliksApi api, ExecutorService io, Handler main, Consumer<JSONObject> sink) {
        this.context = context;
        this.api = api;
        this.io = io;
        this.main = main;
        this.sink = sink;
    }

    /** The target id the beats of this device carry while it is the face; null with no device id. */
    @Nullable
    String targetId() {
        String device = api.deviceId();
        return device == null || device.isEmpty() ? null : device + "#native";
    }

    /** The device is the face again: registrations are allowed until the next `leave`. */
    void want() {
        wanted = true;
    }

    /** Registers the target unless it is or the face was left; blocks, so it runs on the io pool. */
    synchronized void ensure(String key) throws IOException {
        String device = api.deviceId();
        if (registered || !wanted || device == null || device.isEmpty()) return;
        try {
            String body = new JSONObject().put("deviceId", device).put("name", name())
                    .put("formFactor", formFactor()).toString();
            api.send("POST", "/api/remote/register", body, key);
            registered = true;
        } catch (JSONException e) {
            throw new IOException(e);
        }
    }

    /** Fetches the queued commands and hands each to the sink on the main thread; one fetch at a time. */
    void poll(String key) {
        String target = targetId();
        if (target == null || polling) return;
        wanted = true;
        polling = true;
        io.execute(() -> {
            try {
                ensure(key);
                JSONArray events = new JSONArray(api.send("GET", "/api/remote/commands?targetId=" + Uri.encode(target), null, key));
                for (int i = 0; i < events.length(); i++) {
                    JSONObject event = events.getJSONObject(i);
                    main.post(() -> sink.accept(event));
                }
            } catch (FliksApi.HttpError e) {
                if (e.status == 404) registered = false;
            } catch (IOException | JSONException ignored) {
                // The next poll retries; a command waits 10 s at most.
            } finally {
                polling = false;
            }
        });
    }

    /** The web layer can take commands again: the device is listed through it. */
    void leave(@Nullable String key) {
        String device = api.deviceId();
        if (!wanted && !registered) return;
        wanted = false;
        if (key == null || device == null) return;
        io.execute(() -> {
            synchronized (this) {
                if (!registered) return;
                registered = false;
                try {
                    api.send("DELETE", "/api/remote/register?deviceId=" + Uri.encode(device), null, key);
                } catch (IOException ignored) {
                    // The server drops the target 30 s after its last poll.
                }
            }
        });
    }

    private String name() {
        String chosen = Settings.Global.getString(context.getContentResolver(), "device_name");
        return chosen == null || chosen.isEmpty() ? Build.MANUFACTURER + " " + Build.MODEL : chosen;
    }

    private String formFactor() {
        UiModeManager ui = (UiModeManager) context.getSystemService(Context.UI_MODE_SERVICE);
        if (ui != null && ui.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION) return "tv";
        return context.getResources().getConfiguration().smallestScreenWidthDp >= 600 ? "tablet" : "phone";
    }
}
