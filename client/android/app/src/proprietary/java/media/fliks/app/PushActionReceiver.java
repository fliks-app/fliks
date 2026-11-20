package media.fliks.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/** Runs a `call` action of a notification through {@link FliksApi}, then replaces it with the outcome. */
public class PushActionReceiver extends BroadcastReceiver {
    /** `goAsync` gives the receiver about 10 s. */
    private static final long CALL_BUDGET_MS = 8_000;

    @Override
    public void onReceive(Context context, Intent intent) {
        final Context app = context.getApplicationContext();
        final String token = intent.getStringExtra(PushNotifier.EXTRA_ACTION_TOKEN);
        final String server = intent.getStringExtra(PushNotifier.EXTRA_SERVER);
        final String user = intent.getStringExtra(PushNotifier.EXTRA_USER);
        final String tag = intent.getStringExtra(PushNotifier.EXTRA_TAG);
        final String channel = intent.getStringExtra(PushNotifier.EXTRA_CHANNEL);
        final String title = intent.getStringExtra(PushNotifier.EXTRA_TITLE);
        final String done = intent.getStringExtra(PushNotifier.EXTRA_DONE);
        if (token == null || server == null || user == null || tag == null || channel == null || title == null) return;
        final PendingResult pending = goAsync();
        new Thread(() -> {
            boolean ok = false;
            ExecutorService call = Executors.newSingleThreadExecutor();
            try {
                Future<?> f = call.submit(() -> {
                    FliksApi.shared(app).send("POST", "/api/push/act", new JSONObject().put("token", token).toString(),
                        PushStore.apiKey(server, user));
                    return null;
                });
                try {
                    f.get(CALL_BUDGET_MS, TimeUnit.MILLISECONDS);
                    ok = true;
                } catch (TimeoutException e) {
                    f.cancel(true);
                }
            } catch (Exception e) {
                Log.w("FliksPush", "call action failed: " + e.getMessage());
            } finally {
                call.shutdownNow();
                PushNotifier.showResult(app, tag, channel, title, done, ok);
                pending.finish();
            }
        }).start();
    }
}
