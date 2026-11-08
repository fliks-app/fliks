package media.fliks.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;

public class FliksApiTest {
    private ServerSocket server;
    private String base;
    private final Map<String, String> store = new HashMap<>();
    private final List<String> calls = new CopyOnWriteArrayList<>();
    private FliksApi api;

    @Before
    public void start() throws Exception {
        server = new ServerSocket(0, 10, InetAddress.getByName("127.0.0.1"));
        base = "http://127.0.0.1:" + server.getLocalPort();
        api = new FliksApi(new MapPrefs(store));
        signIn("old");
    }

    @After
    public void stop() throws Exception {
        server.close();
    }

    private void signIn(String token) throws Exception {
        JSONObject s = new JSONObject().put("serverUrl", base).put("user", new JSONObject().put("id", 7))
                .put("accessToken", token).put("refreshToken", "r");
        synchronized (store) {
            store.put("fliks_sessions", new JSONArray().put(s).toString());
            store.put("fliks_active_session", base + "::7");
        }
    }

    /** Answers 401 to `old`, 200 to anything else, and records what it saw. */
    private void serve(Runnable onOldToken) {
        Thread t = new Thread(() -> {
            try {
                while (true) {
                    try (Socket c = server.accept()) {
                        BufferedReader in = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8));
                        String path = in.readLine().split(" ")[1];
                        String auth = null;
                        for (String l = in.readLine(); l != null && !l.isEmpty(); l = in.readLine()) {
                            if (l.toLowerCase().startsWith("authorization:")) auth = l.substring(14).trim();
                        }
                        calls.add(path + " " + auth);
                        boolean old = "Bearer old".equals(auth);
                        if (old) onOldToken.run();
                        String body = old ? "" : "{\"ok\":true}";
                        c.getOutputStream().write(("HTTP/1.1 " + (old ? "401 Unauthorized" : "200 OK")
                                + "\r\nContent-Length: " + body.length() + "\r\nConnection: close\r\n\r\n" + body)
                                .getBytes(StandardCharsets.UTF_8));
                    }
                }
            } catch (Exception closed) {
                // The test closed the server.
            }
        });
        t.setDaemon(true);
        t.start();
    }

    @Test
    public void refusesARequestOfAnotherSession() throws Exception {
        serve(() -> { });
        assertThrows(FliksApi.SessionChanged.class,
                () -> api.postJson("/api/x", "{}", "https://other.example::7"));
        assertTrue(calls.isEmpty());
        assertEquals(base + "::7", api.activeKey());
    }

    @Test
    public void retriesWithTheTokenAnotherCallerAlreadyStored() throws Exception {
        serve(() -> {
            try {
                signIn("new");
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        });
        assertTrue(api.postJson("/api/x", "{}", base + "::7").getBoolean("ok"));
        assertEquals(List.of("/api/x Bearer old", "/api/x Bearer new"), new ArrayList<>(calls));
    }

    @Test
    public void asksTheWebLayerToRefreshAndWaitsForItsToken() throws Exception {
        serve(() -> { });
        api.setWebOwnsRefresh(true, () -> new Thread(() -> {
            try {
                Thread.sleep(300);
                signIn("new");
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        }).start());
        assertTrue(api.postJson("/api/x", "{}", base + "::7").getBoolean("ok"));
        assertEquals("/api/x Bearer new", calls.get(calls.size() - 1));
        assertTrue(calls.stream().noneMatch(c -> c.startsWith("/api/auth/refresh")));
    }

    /** A SharedPreferences over a map: strings only, which is all the session store holds. */
    private static final class MapPrefs implements SharedPreferences {
        private final Map<String, String> map;

        MapPrefs(Map<String, String> map) {
            this.map = map;
        }

        @Override public String getString(String key, String def) {
            synchronized (map) {
                return map.getOrDefault(key, def);
            }
        }

        @Override public Editor edit() {
            return new Editor() {
                @Override public Editor putString(String k, String v) {
                    synchronized (map) {
                        map.put(k, v);
                    }
                    return this;
                }
                @Override public boolean commit() { return true; }
                @Override public void apply() { }
                @Override public Editor putStringSet(String k, Set<String> v) { throw new UnsupportedOperationException(); }
                @Override public Editor putInt(String k, int v) { throw new UnsupportedOperationException(); }
                @Override public Editor putLong(String k, long v) { throw new UnsupportedOperationException(); }
                @Override public Editor putFloat(String k, float v) { throw new UnsupportedOperationException(); }
                @Override public Editor putBoolean(String k, boolean v) { throw new UnsupportedOperationException(); }
                @Override public Editor remove(String k) { throw new UnsupportedOperationException(); }
                @Override public Editor clear() { throw new UnsupportedOperationException(); }
            };
        }

        @Override public Map<String, ?> getAll() { throw new UnsupportedOperationException(); }
        @Override public Set<String> getStringSet(String k, Set<String> d) { throw new UnsupportedOperationException(); }
        @Override public int getInt(String k, int d) { throw new UnsupportedOperationException(); }
        @Override public long getLong(String k, long d) { throw new UnsupportedOperationException(); }
        @Override public float getFloat(String k, float d) { throw new UnsupportedOperationException(); }
        @Override public boolean getBoolean(String k, boolean d) { throw new UnsupportedOperationException(); }
        @Override public boolean contains(String k) { throw new UnsupportedOperationException(); }
        @Override public void registerOnSharedPreferenceChangeListener(OnSharedPreferenceChangeListener l) { }
        @Override public void unregisterOnSharedPreferenceChangeListener(OnSharedPreferenceChangeListener l) { }
    }
}
