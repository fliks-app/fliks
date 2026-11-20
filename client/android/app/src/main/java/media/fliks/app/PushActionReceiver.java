package media.fliks.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import org.json.JSONObject;

/** Runs a `call` action of a notification through {@link FliksApi}, then replaces it with the outcome. */
public class PushActionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        final Context app = context.getApplicationContext();
        final String token = intent.getStringExtra(PushNotifier.EXTRA_ACTION_TOKEN);
        final String server = intent.getStringExtra(PushNotifier.EXTRA_SERVER);
        final String user = intent.getStringExtra(PushNotifier.EXTRA_USER);
        final String tag = intent.getStringExtra(PushNotifier.EXTRA_TAG);
        final String channel = intent.getStringExtra(PushNotifier.EXTRA_CHANNEL);
        final String title = intent.getStringExtra(PushNotifier.EXTRA_TITLE);
        if (token == null || server == null || user == null || tag == null || channel == null || title == null) return;
        final PendingResult pending = goAsync();
        new Thread(() -> {
            boolean ok = false;
            try {
                new FliksApi(app).send("POST", "/api/push/act", new JSONObject().put("token", token).toString(), server + "::" + user);
                ok = true;
            } catch (Exception e) {
                Log.w("FliksPush", "call action failed: " + e.getMessage());
            } finally {
                PushNotifier.showResult(app, tag, channel, title, ok);
                pending.finish();
            }
        }).start();
    }
}
