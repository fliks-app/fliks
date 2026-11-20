package media.fliks.app;

import android.Manifest;
import android.app.UiModeManager;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.os.Build;
import android.provider.Settings;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONObject;

import java.io.IOException;
import java.util.List;

/** Native push of the Android app: FCM token, per-session key pair, relay registration and notification taps. */
@CapacitorPlugin(
    name = "Push",
    permissions = @Permission(strings = {Manifest.permission.POST_NOTIFICATIONS}, alias = "notifications")
)
public class PushPlugin extends Plugin {
    private static PushPlugin instance;
    /** A tap that arrived before the plugin was loaded. */
    @Nullable private static JSObject pendingOpen;

    private PushStore store;

    @Override
    public void load() {
        instance = this;
        store = new PushStore(getContext());
        PushNotifier.ensureChannels(getContext());
        JSObject open = pendingOpen;
        pendingOpen = null;
        if (open != null) notifyListeners("pushOpened", open, true);
        new Thread(this::retryPendingDeletions).start();
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) instance = null;
    }

    /** A notification tap (from {@link MainActivity}); held until the plugin is loaded. */
    static void opened(@Nullable String serverUrl, int userId, String url) {
        JSObject o = new JSObject();
        o.put("url", url);
        if (serverUrl != null) {
            JSObject session = new JSObject();
            session.put("serverUrl", serverUrl);
            session.put("userId", userId);
            session.put("key", PushStore.sessionKey(serverUrl, userId));
            o.put("session", session);
        }
        if (instance != null) instance.notifyListeners("pushOpened", o, true);
        else pendingOpen = o;
    }

    private boolean available() {
        Context ctx = getContext();
        UiModeManager ui = (UiModeManager) ctx.getSystemService(Context.UI_MODE_SERVICE);
        boolean tv = ui != null && ui.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION;
        return !tv && Flavor.pushAvailable(ctx);
    }

    private boolean granted() {
        return NotificationManagerCompat.from(getContext()).areNotificationsEnabled();
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject r = new JSObject();
        r.put("available", available());
        r.put("permission", permission());
        call.resolve(r);
    }

    /** `prompt` while Android 13+ can still show its dialog; app notifications switched off read as `denied`. */
    private String permission() {
        if (granted()) return "granted";
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return "denied";
        PermissionState state = getPermissionState("notifications");
        return state == PermissionState.PROMPT || state == PermissionState.PROMPT_WITH_RATIONALE ? "prompt" : "denied";
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        if ("prompt".equals(permission())) requestPermissionForAlias("notifications", call, "permissionAnswered");
        else permissionAnswered(call);
    }

    @PermissionCallback
    private void permissionAnswered(PluginCall call) {
        JSObject r = new JSObject();
        r.put("permission", permission());
        call.resolve(r);
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent intent = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName())
            : new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.fromParts("package", getContext().getPackageName(), null));
        getActivity().startActivity(intent);
        call.resolve();
    }

    @PluginMethod
    public void prepare(PluginCall call) {
        if (!available()) {
            call.reject("push unavailable");
            return;
        }
        if (!granted()) {
            call.reject("notification permission denied");
            return;
        }
        String session = call.getString("session", "");
        try {
            Flavor.enablePush();
            JSONObject entry = store.get(session);
            if (entry == null) {
                PushCrypto.Keys keys = PushCrypto.generate();
                byte[] auth = new byte[16];
                new java.security.SecureRandom().nextBytes(auth);
                int at = session.lastIndexOf('|');
                entry = new JSONObject().put("session", session).put("serverUrl", session.substring(0, at))
                    .put("userId", Integer.parseInt(session.substring(at + 1)))
                    .put("priv", store.wrap(keys.priv)).put("pub", B64.encode(keys.pub)).put("auth", B64.encode(auth));
            }
            entry.remove("deleting");
            store.put(entry);
            JSObject r = new JSObject();
            r.put("platform", "fcm");
            r.put("p256dh", entry.getString("pub"));
            r.put("auth", entry.getString("auth"));
            call.resolve(r);
        } catch (Exception e) {
            call.reject("prepare failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void subscribe(PluginCall call) {
        final String session = call.getString("session", "");
        final String ticket = call.getString("ticket", "");
        new Thread(() -> {
            try {
                JSONObject entry = store.get(session);
                if (entry == null) throw new IOException("no key for this session");
                PushRelay.Ticket t = PushRelay.parse(ticket);
                String relay = PushRelay.forAudience(PushRelay.urls(getContext()), t.aud);
                if (relay == null) throw new IOException("ticket for an unknown relay");
                String token = Flavor.pushToken(15);
                boolean unchanged = relay.equals(entry.optString("relay")) && token.equals(entry.optString("token"))
                    && t.sub.equals(entry.optString("sub"));
                if (!unchanged) PushRelay.put(relay, ticket, token);
                entry.put("sub", t.sub).put("k", t.key).put("relay", relay).put("token", token);
                store.put(entry);
                call.resolve();
            } catch (Exception e) {
                call.reject("subscribe failed: " + e.getMessage());
            }
        }).start();
    }

    @PluginMethod
    public void unsubscribe(PluginCall call) {
        final String session = call.getString("session", "");
        new Thread(() -> {
            JSONObject entry = store.get(session);
            if (entry != null) {
                try {
                    entry.put("deleting", true);
                    store.put(entry);
                } catch (org.json.JSONException ignored) {
                    // A boolean put cannot fail.
                }
                drop(entry);
            }
            call.resolve();
        }).start();
    }

    /** Deletes the relay row of `entry` and erases its key once the relay confirmed; else it stays pending. */
    private void drop(JSONObject entry) {
        String sub = entry.optString("sub");
        String token = entry.optString("token");
        String relay = entry.optString("relay");
        try {
            if (!sub.isEmpty() && !token.isEmpty() && !relay.isEmpty()) PushRelay.delete(relay, token, sub);
            store.removeIfDeleting(entry.optString("session"));
        } catch (IOException e) {
            // Kept marked for the next launch.
        }
    }

    private void retryPendingDeletions() {
        List<JSONObject> all = store.all();
        for (JSONObject e : all) if (e.optBoolean("deleting")) drop(e);
    }

    /** Launcher dots follow the notifications; Android shows no number. */
    @PluginMethod
    public void setBadge(PluginCall call) {
        call.resolve();
    }

    /** Reads the tap an intent carries (cold start or `onNewIntent`) and forwards it to the web layer. */
    static void handleIntent(Context ctx, Intent intent) {
        if (intent == null || !intent.hasExtra(PushNotifier.EXTRA_URL)) return;
        String url = intent.getStringExtra(PushNotifier.EXTRA_URL);
        String server = intent.getStringExtra(PushNotifier.EXTRA_SERVER);
        String user = intent.getStringExtra(PushNotifier.EXTRA_USER);
        String tag = intent.getStringExtra(PushNotifier.EXTRA_TAG);
        intent.removeExtra(PushNotifier.EXTRA_URL);
        if (tag != null) PushNotifier.cancel(ctx, tag);
        if (url == null || url.isEmpty()) return;
        // The extras are not trusted: only a session this device holds a subscription for is forwarded.
        try {
            int id = Integer.parseInt(user);
            if (server != null && new PushStore(ctx).get(PushStore.sessionKey(server, id)) != null) opened(server, id, url);
        } catch (NumberFormatException e) {
            // No session: nothing is opened.
        }
    }
}
