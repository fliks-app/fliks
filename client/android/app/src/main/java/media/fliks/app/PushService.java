package media.fliks.app;

import android.util.Log;

import androidx.annotation.NonNull;

import com.google.android.gms.tasks.Tasks;
import com.google.firebase.messaging.FirebaseMessaging;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/** Receives the relay's data messages `{k, s, p}`, checks them and shows the decrypted notification. */
public class PushService extends FirebaseMessagingService {
    private static final String TAG = "FliksPush";

    @Override
    public void onNewToken(@NonNull String token) {
        // The new token is registered at the relay by the next launch.
    }

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        Map<String, String> d = message.getData();
        String k = d.get("k");
        String s = d.get("s");
        String p = d.get("p");
        if (k == null || s == null || p == null) return;
        PushStore store = new PushStore(this);
        JSONObject entry = store.bySub(s);
        if (entry == null) {
            forget(s);
            return;
        }
        if (!k.equals(entry.optString("k")) || entry.optBoolean("deleting")) return;
        JSONObject plain;
        try {
            byte[] raw = PushCrypto.decrypt(B64.decode(p),
                new PushCrypto.Keys(store.unwrap(entry), B64.decode(entry.getString("pub"))),
                B64.decode(entry.getString("auth")));
            plain = new JSONObject(new String(raw, StandardCharsets.UTF_8));
        } catch (Exception e) {
            Log.w(TAG, "undecryptable push: " + e.getClass().getSimpleName());
            PushNotifier.showFallback(this);
            return;
        }
        if (PushRules.expired(plain.optLong("ts"), plain.optLong("ttl"), System.currentTimeMillis() / 1000)) return;
        if (!store.markSeen(plain.optString("id"))) return;
        if (PushNotifier.foreground && onScreen(entry)) return;
        try {
            PushNotifier.show(this, entry, plain);
        } catch (RuntimeException | OutOfMemoryError e) {
            Log.w(TAG, "show failed: " + e.getClass().getSimpleName());
            PushNotifier.showFallback(this);
        }
    }

    private boolean onScreen(JSONObject entry) {
        String active = FliksApi.shared(this).activeKey();
        return active != null && active.equals(PushStore.apiKey(entry.optString("serverUrl"), String.valueOf(entry.optInt("userId"))));
    }

    /** An unknown subscription id: the relay is told to drop it, whichever relay of this build holds it. */
    private void forget(String sub) {
        try {
            String token = Tasks.await(FirebaseMessaging.getInstance().getToken(), 5, TimeUnit.SECONDS);
            for (String relay : PushRelay.urls(this)) {
                try {
                    PushRelay.delete(relay, token, sub);
                } catch (java.io.IOException e) {
                    Log.w(TAG, "relay delete failed: " + e.getMessage());
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "no token to delete with: " + e.getMessage());
        }
    }
}
