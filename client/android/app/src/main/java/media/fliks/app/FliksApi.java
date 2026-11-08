package media.fliks.app;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/** The fliks API from native code, with the session the web layer stores in Capacitor
 *  Preferences. While a WebView exists it owns token refresh. */
final class FliksApi {
    private static final String CAPACITOR_PREFS = "CapacitorStorage";
    private static final String SESSIONS_KEY = "fliks_sessions";
    private static final String ACTIVE_KEY = "fliks_active_session";

    static final class HttpError extends IOException {
        final int status;

        HttpError(int status, String message) {
            super(message);
            this.status = status;
        }
    }

    /** The session a queue started under is no longer the signed-in one. */
    static final class SessionChanged extends IOException {
        SessionChanged() {
            super("session changed");
        }
    }

    private static final long REFRESH_WAIT_MS = 10_000;
    private static final long STREAM_TOKEN_MIN_LIFE_MS = 30 * 60 * 1000;

    private final SharedPreferences prefs;
    private volatile boolean webOwnsRefresh;
    @Nullable private volatile Runnable refreshRequest;
    private final Map<String, StreamToken> streamTokens = new HashMap<>();

    private static final class StreamToken {
        final String token;
        final long expiresAt;

        StreamToken(String token, long expiresAt) {
            this.token = token;
            this.expiresAt = expiresAt;
        }
    }

    FliksApi(Context context) {
        this(context.getApplicationContext().getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE));
    }

    FliksApi(SharedPreferences prefs) {
        this.prefs = prefs;
    }

    /** While a WebView exists it owns token rotation; `request` asks it to refresh through this. */
    void setWebOwnsRefresh(boolean owns, @Nullable Runnable request) {
        webOwnsRefresh = owns;
        refreshRequest = request;
    }

    private static String key(JSONObject s) {
        return s.optString("serverUrl") + "::" + s.optJSONObject("user").optInt("id");
    }

    @Nullable
    private JSONObject active() {
        try {
            String activeKey = prefs.getString(ACTIVE_KEY, null);
            String raw = prefs.getString(SESSIONS_KEY, null);
            if (activeKey == null || raw == null) return null;
            JSONArray list = new JSONArray(raw);
            for (int i = 0; i < list.length(); i++) {
                JSONObject s = list.getJSONObject(i);
                if (activeKey.equals(key(s))) return s;
            }
        } catch (JSONException | RuntimeException ignored) {
            // A malformed store reads as signed out.
        }
        return null;
    }

    /** Server and user of the signed-in session, null when signed out. */
    @Nullable
    String activeKey() {
        JSONObject s = active();
        return s == null || s.optString("accessToken").isEmpty() ? null : key(s);
    }

    boolean signedIn() {
        return activeKey() != null;
    }

    @Nullable
    String serverUrl() {
        JSONObject s = active();
        return s == null ? null : s.optString("serverUrl");
    }

    /** Server-relative path made absolute; images are public, so no token rides along. */
    String absolute(String path) {
        String base = serverUrl();
        return base == null || path.startsWith("http") ? path : base + path;
    }

    /** A stream URL bound to `mediaFileId`, minted (and reused while it has life left) on the stream scope. */
    String streamUrl(String path, String sessionId, long mediaFileId, String boundKey) throws IOException {
        String base = serverUrl();
        if (base == null) throw new HttpError(401, "signed out");
        return base + path + "?sid=" + android.net.Uri.encode(sessionId) + "&token="
                + android.net.Uri.encode(streamToken(mediaFileId, boundKey));
    }

    private synchronized String streamToken(long mediaFileId, String boundKey) throws IOException {
        String id = boundKey + "#" + mediaFileId;
        StreamToken known = streamTokens.get(id);
        if (known != null && known.expiresAt - System.currentTimeMillis() > STREAM_TOKEN_MIN_LIFE_MS) return known.token;
        try {
            JSONObject res = new JSONObject(request("POST", "/api/auth/stream-token",
                    new JSONObject().put("mediaFileId", mediaFileId).toString(), boundKey));
            StreamToken minted = new StreamToken(res.getString("streamToken"), res.getLong("expiresAt"));
            streamTokens.put(id, minted);
            return minted.token;
        } catch (JSONException e) {
            throw new IOException(e);
        }
    }

    JSONObject getJson(String path) throws IOException, JSONException {
        return new JSONObject(request("GET", path, null, null));
    }

    JSONArray getArray(String path) throws IOException, JSONException {
        return new JSONArray(request("GET", path, null, null));
    }

    /** Playback calls name the session the queue started under: none is made for another one. */
    JSONObject postJson(String path, String body, String boundKey) throws IOException, JSONException {
        return new JSONObject(request("POST", path, body, boundKey));
    }

    void send(String method, String path, @Nullable String body, String boundKey) throws IOException {
        request(method, path, body, boundKey);
    }

    private String request(String method, String path, @Nullable String body, @Nullable String boundKey)
            throws IOException {
        JSONObject s = active();
        for (int attempt = 0; ; attempt++) {
            if (s == null || s.optString("accessToken").isEmpty()) throw new HttpError(401, "signed out");
            if (boundKey != null && !boundKey.equals(key(s))) throw new SessionChanged();
            String sent = s.optString("accessToken");
            try {
                return once(s.optString("serverUrl"), sent, method, path, body);
            } catch (HttpError e) {
                if (e.status != 401 || attempt > 0 || !refresh(key(s), sent)) throw e;
                s = active();
            }
        }
    }

    private String once(String base, String token, String method, String path, @Nullable String body)
            throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(base + path).openConnection();
        try {
            c.setRequestMethod(method);
            c.setConnectTimeout(15_000);
            c.setReadTimeout(30_000);
            c.setRequestProperty("Authorization", "Bearer " + token);
            c.setRequestProperty("Accept", "application/json");
            if (body != null) {
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                try (OutputStream out = c.getOutputStream()) {
                    out.write(body.getBytes(StandardCharsets.UTF_8));
                }
            }
            int status = c.getResponseCode();
            if (status >= 400) throw new HttpError(status, method + " " + path + " " + status);
            try (InputStream in = c.getInputStream()) {
                return read(in);
            }
        } finally {
            c.disconnect();
        }
    }

    private static String read(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
        return out.toString("UTF-8");
    }

    @Nullable
    private JSONObject session(String key) {
        try {
            JSONArray list = new JSONArray(prefs.getString(SESSIONS_KEY, "[]"));
            for (int i = 0; i < list.length(); i++) {
                if (key.equals(key(list.getJSONObject(i)))) return list.getJSONObject(i);
            }
        } catch (JSONException | RuntimeException ignored) {
            // A malformed store has no session.
        }
        return null;
    }

    /** True once the session `key` holds a token other than `sent`, the one that was rejected: another
     *  caller or the web layer already rotated it. Otherwise the web layer, while it exists, is asked to
     *  refresh and awaited; with none, the stored pair is rotated here. */
    private synchronized boolean refresh(String key, String sent) {
        JSONObject s = session(key);
        if (s == null) return false;
        if (!sent.equals(s.optString("accessToken"))) return true;
        if (webOwnsRefresh) {
            Runnable ask = refreshRequest;
            if (ask != null) ask.run();
            long deadline = System.currentTimeMillis() + REFRESH_WAIT_MS;
            while (System.currentTimeMillis() < deadline) {
                try {
                    Thread.sleep(200);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return false;
                }
                JSONObject now = session(key);
                if (now == null) return false;
                if (!sent.equals(now.optString("accessToken"))) return true;
            }
            return false;
        }
        return rotate(s);
    }

    private boolean rotate(JSONObject s) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(s.optString("serverUrl") + "/api/auth/refresh").openConnection();
            try {
                c.setRequestMethod("POST");
                c.setConnectTimeout(15_000);
                c.setReadTimeout(30_000);
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                try (OutputStream out = c.getOutputStream()) {
                    out.write(new JSONObject().put("refreshToken", s.optString("refreshToken")).toString()
                            .getBytes(StandardCharsets.UTF_8));
                }
                if (c.getResponseCode() >= 400) return false;
                JSONObject res;
                try (InputStream in = c.getInputStream()) {
                    res = new JSONObject(read(in));
                }
                long exp = res.optLong("refreshTokenExpiresAt", 0);
                s.put("accessToken", res.getString("accessToken"));
                s.put("refreshToken", res.getString("refreshToken"));
                s.put("refreshExpiresAt", exp > 0 ? exp * 1000 : JSONObject.NULL);
                s.put("tokenVersion", s.optInt("tokenVersion", 0) + 1);
                persist(s);
                return true;
            } finally {
                c.disconnect();
            }
        } catch (IOException | JSONException e) {
            return false;
        }
    }

    private void persist(JSONObject updated) throws JSONException {
        JSONArray list = new JSONArray(prefs.getString(SESSIONS_KEY, "[]"));
        for (int i = 0; i < list.length(); i++) {
            if (key(list.getJSONObject(i)).equals(key(updated))) list.put(i, updated);
        }
        prefs.edit().putString(SESSIONS_KEY, list.toString()).commit();
    }
}
