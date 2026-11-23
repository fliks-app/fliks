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
 *  Preferences. A web layer that is loaded is asked to refresh first. */
final class FliksApi {
    /** The kinds of the bundled web registry (`KIND_REGISTRY`), declared to the server. */
    private static final String KINDS = "movie,series,book,comic,album";

    /** The `X-Fliks-Client` value every request to the server carries. */
    static final String CLIENT = "android/" + BuildConfig.VERSION_NAME;

    private static final String CAPACITOR_PREFS = "CapacitorStorage";
    private static final String SESSIONS_KEY = "fliks_sessions";
    private static final String ACTIVE_KEY = "fliks_active_session";
    private static final String DEVICE_ID_KEY = "fliks_device_id";

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

    private static final long ADOPT_WAIT_MS = 2_000;
    private static final long STREAM_TOKEN_MIN_LIFE_MS = 30 * 60 * 1000;

    private final SharedPreferences prefs;
    /** How long a loaded web layer has to answer a refresh request before native rotates itself. */
    long refreshWaitMs = 10_000;
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

    private static FliksApi shared;

    /** The one instance of the process, so a refresh is owned by one place whoever calls. */
    static synchronized FliksApi shared(Context context) {
        if (shared == null) shared = new FliksApi(context);
        return shared;
    }

    FliksApi(Context context) {
        this(context.getApplicationContext().getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE));
    }

    FliksApi(SharedPreferences prefs) {
        this.prefs = prefs;
    }

    /** While a WebView is loaded, `request` asks it to refresh through this before native rotates. */
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

    /** The installation id the web layer stores; on this shell it is the remote target id. */
    @Nullable
    String deviceId() {
        return prefs.getString(DEVICE_ID_KEY, null);
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

    String streamToken(long mediaFileId, String boundKey) throws IOException {
        String id = boundKey + "#" + mediaFileId;
        StreamToken known;
        synchronized (streamTokens) {
            known = streamTokens.get(id);
        }
        if (known != null && known.expiresAt - System.currentTimeMillis() > STREAM_TOKEN_MIN_LIFE_MS) return known.token;
        try {
            JSONObject res = new JSONObject(request("POST", "/api/auth/stream-token",
                    new JSONObject().put("mediaFileId", mediaFileId).toString(), boundKey));
            StreamToken minted = new StreamToken(res.getString("streamToken"), res.getLong("expiresAt"));
            synchronized (streamTokens) {
                streamTokens.put(id, minted);
            }
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

    String send(String method, String path, @Nullable String body, String boundKey) throws IOException {
        return request(method, path, body, boundKey);
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
            c.setRequestProperty("X-Fliks-Kinds", KINDS);
            c.setRequestProperty("X-Fliks-Client", CLIENT);
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

    /** Asks the web layer first when it is loaded; else, or when it stays silent, rotates the stored pair. */
    private boolean refresh(String key, String sent) throws IOException {
        if (webOwnsRefresh) {
            Runnable ask = refreshRequest;
            if (ask != null) ask.run();
            if (awaitChange(key, sent, refreshWaitMs)) return true;
        }
        return rotateIfStale(key, sent) || awaitChange(key, sent, ADOPT_WAIT_MS);
    }

    /** True once the session `key` holds a token other than `sent` (or is gone), within `waitMs`. */
    private boolean awaitChange(String key, String sent, long waitMs) throws IOException {
        long deadline = System.currentTimeMillis() + waitMs;
        while (System.currentTimeMillis() < deadline) {
            try {
                Thread.sleep(200);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IOException("interrupted", e);
            }
            JSONObject now = session(key);
            if (now == null || !sent.equals(now.optString("accessToken"))) return true;
        }
        return false;
    }

    private synchronized boolean rotateIfStale(String key, String sent) throws IOException {
        JSONObject s = session(key);
        if (s == null) return false;
        if (!sent.equals(s.optString("accessToken"))) return true;
        return rotate(s);
    }

    /** False when the server rejects the refresh token (4xx); any other failure throws. */
    private boolean rotate(JSONObject s) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(s.optString("serverUrl") + "/api/auth/refresh").openConnection();
        try {
            c.setRequestMethod("POST");
            c.setConnectTimeout(15_000);
            c.setReadTimeout(30_000);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("X-Fliks-Client", CLIENT);
            try (OutputStream out = c.getOutputStream()) {
                out.write(new JSONObject().put("refreshToken", s.optString("refreshToken")).toString()
                        .getBytes(StandardCharsets.UTF_8));
            }
            int status = c.getResponseCode();
            if (status >= 400 && status < 500) return false;
            if (status >= 400) throw new IOException("POST /api/auth/refresh " + status);
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
        } catch (JSONException e) {
            throw new IOException(e);
        } finally {
            c.disconnect();
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
