package media.fliks.app;

import android.os.SystemClock;

import androidx.annotation.Nullable;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Repeats the JS position heartbeat while the app is stopped: the WebView is throttled then (background audio,
 *  locked cast), taking the JS timer with it. Main thread only. */
final class PositionHeartbeat {
    private static final long INTERVAL_MS = 10_000;
    private static final ExecutorService IO = Executors.newSingleThreadExecutor();

    @Nullable private String url;
    private String token = "";
    private JSONObject body = new JSONObject();
    private long lastSent;

    /** `body` is the last JS heartbeat; it carries the session and file ids the server needs. */
    void set(String url, String token, JSONObject body) {
        this.url = url;
        this.token = token;
        this.body = body;
    }

    void clear() {
        url = null;
        body = new JSONObject();
    }

    /** False when the receiver plays another file or another load than the one `body` names. */
    boolean ownsFile(@Nullable JSONObject customData) {
        if (customData == null || !customData.has("mediaFileId") || !body.has("mediaFileId")) return false;
        if (!String.valueOf(customData.opt("mediaFileId")).equals(String.valueOf(body.opt("mediaFileId")))) return false;
        String sid = body.optString("sessionId", null);
        return sid == null || sid.equals(customData.optString("sid", null));
    }

    /** `state` is sent only with a session: without one the server takes the beat as a plain position save. */
    void send(double position, double duration, String state) {
        long now = SystemClock.elapsedRealtime();
        if (url == null || !Double.isFinite(position) || PushNotifier.foreground
                || lastSent != 0 && now - lastSent < INTERVAL_MS) return;
        final String target = url;
        final String auth = "Bearer " + token;
        final String payload;
        try {
            JSONObject o = new JSONObject(body.toString());
            o.put("positionSeconds", position);
            if (Double.isFinite(duration) && duration > 0) o.put("durationSeconds", duration);
            if (o.has("sessionId")) o.put("state", state);
            payload = o.toString();
        } catch (JSONException e) {
            return;
        }
        lastSent = now;
        IO.execute(() -> put(target, auth, payload));
    }

    private static void put(String target, String auth, String payload) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(target).openConnection();
            c.setRequestMethod("PUT");
            c.setConnectTimeout(10_000);
            c.setReadTimeout(10_000);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("Authorization", auth);
            c.setRequestProperty("X-Fliks-Client", FliksApi.CLIENT);
            try (OutputStream out = c.getOutputStream()) {
                out.write(payload.getBytes(StandardCharsets.UTF_8));
            }
            c.getResponseCode();
        } catch (IOException ignored) {
            // The next beat retries.
        } finally {
            if (c != null) c.disconnect();
        }
    }
}
