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

/** The fliks API from native code, with the session the web layer stores in Capacitor
 *  Preferences. While the web layer observes the player it owns token refresh. */
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

    private final SharedPreferences prefs;
    private volatile boolean webOwnsRefresh;

    FliksApi(Context context) {
        prefs = context.getApplicationContext().getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE);
    }

    void setWebOwnsRefresh(boolean owns) {
        webOwnsRefresh = owns;
    }

    private static String key(JSONObject s) {
        return s.optString("serverUrl") + "::" + s.optJSONObject("user").optInt("id");
    }

    @Nullable
    private synchronized JSONObject active() {
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

    boolean signedIn() {
        JSONObject s = active();
        return s != null && !s.optString("accessToken").isEmpty();
    }

    @Nullable
    String serverUrl() {
        JSONObject s = active();
        return s == null ? null : s.optString("serverUrl");
    }

    @Nullable
    String accessToken() {
        JSONObject s = active();
        String t = s == null ? "" : s.optString("accessToken");
        return t.isEmpty() ? null : t;
    }

    /** Server-relative path made absolute, with the access token as `token` (images, streams). */
    String absolute(String path, boolean withToken) {
        String base = serverUrl();
        String token = accessToken();
        if (base == null) return path;
        String url = path.startsWith("http") ? path : base + path;
        if (!withToken || token == null || !url.startsWith(base)) return url;
        return url + (url.contains("?") ? "&" : "?") + "token=" + android.net.Uri.encode(token);
    }

    JSONObject getJson(String path) throws IOException, JSONException {
        return new JSONObject(request("GET", path, null));
    }

    JSONArray getArray(String path) throws IOException, JSONException {
        return new JSONArray(request("GET", path, null));
    }

    JSONObject postJson(String path, String body) throws IOException, JSONException {
        return new JSONObject(request("POST", path, body));
    }

    void send(String method, String path, @Nullable String body) throws IOException {
        request(method, path, body);
    }

    private String request(String method, String path, @Nullable String body) throws IOException {
        try {
            return once(method, path, body);
        } catch (HttpError e) {
            if (e.status != 401 || !refresh()) throw e;
            return once(method, path, body);
        }
    }

    private String once(String method, String path, @Nullable String body) throws IOException {
        String base = serverUrl();
        String token = accessToken();
        if (base == null || token == null) throw new HttpError(401, "signed out");
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

    /** Rotates the stored pair when the web layer is not running; with it running, true once
     *  the store holds a token other than the rejected one (the web layer refreshes and persists). */
    private synchronized boolean refresh() {
        JSONObject s = active();
        if (s == null) return false;
        if (webOwnsRefresh) {
            try {
                Thread.sleep(1500);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return false;
            }
            JSONObject now = active();
            return now != null && !now.optString("accessToken").equals(s.optString("accessToken"));
        }
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
