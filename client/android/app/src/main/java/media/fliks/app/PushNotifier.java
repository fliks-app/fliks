package media.fliks.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.UUID;

/** Builds and posts the system notification of a decrypted push, and the done or failed line of a call action. */
final class PushNotifier {
    static final String EXTRA_URL = "fliks.push.url";
    static final String EXTRA_SERVER = "fliks.push.server";
    static final String EXTRA_USER = "fliks.push.user";
    static final String EXTRA_TAG = "fliks.push.tag";
    static final String EXTRA_ACTION_TOKEN = "fliks.push.token";
    static final String EXTRA_TITLE = "fliks.push.title";
    static final String EXTRA_CHANNEL = "fliks.push.channel";
    static final String ACTION_CALL = "media.fliks.app.PUSH_CALL";

    private static final int NOTIFICATION_ID = 1;
    private static final int IMAGE_TIMEOUT_MS = 3_000;
    /** Whole download budget; FCM gives the service about 20 s. */
    private static final long IMAGE_DEADLINE_MS = 6_000;
    private static final int IMAGE_MAX_SIDE = 1024;
    private static final int IMAGE_MAX_BYTES = 3 * 1024 * 1024;
    private static final String[] CATEGORIES = {"requests", "parties", "social", "episodes", "account"};

    /** True while the activity is started; the plugin hides a notification of the session on screen. */
    static volatile boolean foreground;

    private PushNotifier() {}

    /** Creates one channel per category; `plugin.<id>` and unknown categories share the last one. */
    static void ensureChannels(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;
        create(ctx, nm, "requests", R.string.push_channel_requests);
        create(ctx, nm, "parties", R.string.push_channel_parties);
        create(ctx, nm, "social", R.string.push_channel_social);
        create(ctx, nm, "episodes", R.string.push_channel_episodes);
        create(ctx, nm, "account", R.string.push_channel_account);
        create(ctx, nm, "other", R.string.push_channel_other);
    }

    private static void create(Context ctx, NotificationManager nm, String cat, int name) {
        int importance = cat.equals("episodes") || cat.equals("social") || cat.equals("other")
            ? NotificationManager.IMPORTANCE_DEFAULT : NotificationManager.IMPORTANCE_HIGH;
        nm.createNotificationChannel(new NotificationChannel("push_" + cat, ctx.getString(name), importance));
    }

    static String channelFor(String cat) {
        for (String c : CATEGORIES) if (c.equals(cat)) return "push_" + cat;
        return "push_other";
    }

    /** The notification of a decrypted payload for the subscription `entry`. */
    static void show(Context ctx, JSONObject entry, JSONObject p) {
        ensureChannels(ctx);
        String server = entry.optString("serverUrl");
        String userId = String.valueOf(entry.optInt("userId"));
        String tag = p.optString("tag", p.optString("id"));
        if (tag.isEmpty()) tag = UUID.randomUUID().toString();
        String channel = channelFor(p.optString("cat"));
        NotificationCompat.Builder b = base(ctx, channel, p.optString("title"), p.optString("body"));
        b.setContentIntent(openIntent(ctx, server, userId, p.optString("url"), tag, "open"));

        JSONArray actions = p.optJSONArray("actions");
        for (int i = 0; actions != null && i < Math.min(actions.length(), 2); i++) {
            JSONObject a = actions.optJSONObject(i);
            if (a == null) continue;
            if ("call".equals(a.optString("kind"))) {
                Intent call = new Intent(ctx, PushActionReceiver.class).setAction(ACTION_CALL)
                    .putExtra(EXTRA_ACTION_TOKEN, a.optString("token")).putExtra(EXTRA_SERVER, server)
                    .putExtra(EXTRA_USER, userId).putExtra(EXTRA_TAG, tag).putExtra(EXTRA_CHANNEL, channel)
                    .putExtra(EXTRA_TITLE, p.optString("title"));
                b.addAction(0, a.optString("title"), PendingIntent.getBroadcast(ctx, PushRules.requestCode(tag, "call" + i),
                    call, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
            } else {
                b.addAction(0, a.optString("title"), openIntent(ctx, server, userId, a.optString("url"), tag, "action" + i));
            }
        }

        String image = p.optString("image");
        if (image.startsWith("/")) {
            Bitmap bmp = fetchImage(server + image);
            if (bmp != null) b.setLargeIcon(bmp).setStyle(new NotificationCompat.BigPictureStyle().bigPicture(bmp).bigLargeIcon((Bitmap) null));
        }
        post(ctx, tag, b);
    }

    /** The text of a push that could not be decrypted: it still has to end in a visible notification. */
    static void showFallback(Context ctx) {
        ensureChannels(ctx);
        NotificationCompat.Builder b = base(ctx, channelFor(""), ctx.getString(R.string.push_fallback_title),
            ctx.getString(R.string.push_fallback_body));
        b.setContentIntent(openIntent(ctx, "", "", "", "fallback", "open"));
        post(ctx, "fallback", b);
    }

    /** Replaces the notification of a call action with its outcome. */
    static void showResult(Context ctx, String tag, String channel, String title, boolean ok) {
        NotificationCompat.Builder b = base(ctx, channel, title,
            ctx.getString(ok ? R.string.push_action_done : R.string.push_action_failed));
        b.setContentIntent(openIntent(ctx, "", "", "", tag, "open"));
        post(ctx, tag, b);
    }

    private static NotificationCompat.Builder base(Context ctx, String channel, String title, String body) {
        return new NotificationCompat.Builder(ctx, channel)
            .setSmallIcon(R.drawable.ic_stat_fliks)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_SOCIAL);
    }

    private static PendingIntent openIntent(Context ctx, String server, String userId, String url, String tag, String purpose) {
        Intent i = new Intent(ctx, MainActivity.class).setAction(Intent.ACTION_MAIN)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(EXTRA_URL, url).putExtra(EXTRA_SERVER, server).putExtra(EXTRA_USER, userId).putExtra(EXTRA_TAG, tag);
        return PendingIntent.getActivity(ctx, PushRules.requestCode(tag, purpose), i,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static void post(Context ctx, String tag, NotificationCompat.Builder b) {
        NotificationManagerCompat nm = NotificationManagerCompat.from(ctx);
        if (!nm.areNotificationsEnabled()) return;
        try {
            nm.notify(tag, NOTIFICATION_ID, b.build());
        } catch (SecurityException ignored) {
            // The permission was revoked between the check and the post.
        }
    }

    static void cancel(Context ctx, String tag) {
        NotificationManagerCompat.from(ctx).cancel(tag, NOTIFICATION_ID);
    }

    @Nullable
    private static Bitmap fetchImage(String url) {
        HttpURLConnection c = null;
        try {
            long deadline = System.currentTimeMillis() + IMAGE_DEADLINE_MS;
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(IMAGE_TIMEOUT_MS);
            c.setReadTimeout(IMAGE_TIMEOUT_MS);
            if (c.getResponseCode() != 200) return null;
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            try (InputStream in = c.getInputStream()) {
                byte[] buf = new byte[8192];
                for (int n; (n = in.read(buf)) > 0; ) {
                    out.write(buf, 0, n);
                    if (out.size() > IMAGE_MAX_BYTES || System.currentTimeMillis() > deadline) return null;
                }
            }
            byte[] data = out.toByteArray();
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(data, 0, data.length, o);
            if (o.outWidth <= 0 || o.outHeight <= 0) return null;
            o.inSampleSize = Integer.highestOneBit(Math.max(1, Math.max(o.outWidth, o.outHeight) / IMAGE_MAX_SIDE));
            o.inJustDecodeBounds = false;
            return BitmapFactory.decodeByteArray(data, 0, data.length, o);
        } catch (IOException | RuntimeException | OutOfMemoryError e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }
}
