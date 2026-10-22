package media.fliks.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.text.format.DateUtils;

import androidx.annotation.OptIn;
import androidx.core.app.NotificationCompat;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.offline.Download;
import androidx.media3.exoplayer.offline.DownloadManager;
import androidx.media3.exoplayer.offline.DownloadService;

import com.getcapacitor.JSObject;

import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;

/** Download notifications: ongoing summary, paused, and per-item completion or failure.
 *  All wording is translated by the WebView ({@link #setCopy}) and persisted for service restarts. */
@OptIn(markerClass = UnstableApi.class)
final class FlixDownloadNotifications {
    static final int PAUSED_ID = FlixDownloadUtil.FOREGROUND_NOTIFICATION_ID + 1;
    private static final String PREFS = "fliks_download_copy";
    private static final String[] COPY_KEYS = {
        "channelName", "channelDescription", "progress", "paused", "complete", "failed",
        "activeCount", "timeLeft", "pause", "resume",
    };
    private static final int PAUSE_STOP_REASON = 1;
    private static final long WINDOW_MS = 30_000;
    private static final long MIN_SPAN_MS = 5_000;
    private static final int MAX_LINES = 5;

    private static final ArrayDeque<long[]> samples = new ArrayDeque<>();
    private static int sampleKey;

    private FlixDownloadNotifications() {}

    static void setCopy(Context ctx, JSObject copy) {
        SharedPreferences.Editor edit = prefs(ctx).edit();
        for (String key : COPY_KEYS) {
            String value = copy.getString(key);
            if (value != null) edit.putString(key, value);
        }
        edit.apply();
        ensureChannel(ctx);
    }

    static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
            FlixDownloadUtil.DOWNLOAD_CHANNEL_ID,
            str(ctx, "channelName", FlixDownloadUtil.DOWNLOAD_CHANNEL_ID),
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription(str(ctx, "channelDescription", ""));
        channel.enableLights(false);
        channel.enableVibration(false);
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm != null) nm.createNotificationChannel(channel);
    }

    /** Summary of the queue: the ongoing notification, or the paused one when nothing is moving. */
    static Notification build(Context ctx, List<Download> downloads) {
        List<Download> items = new ArrayList<>();
        for (Download d : downloads) if (isActive(d)) items.add(d);
        boolean paused = items.isEmpty();
        if (paused) for (Download d : downloads) if (isPaused(d)) items.add(d);

        int n = items.size();
        float sum = 0;
        int key = n;
        for (Download d : items) {
            sum += Math.max(0f, d.getPercentDownloaded());
            key = key * 31 + d.request.id.hashCode();
        }
        int percent = n == 0 ? 0 : Math.round(sum / n);

        String text = percent + "% · " + str(ctx, paused ? "paused" : "progress", "");
        if (!paused) {
            long ms = remainingMs(key, sum, n);
            if (ms > 0) {
                text += " · " + str(ctx, "timeLeft", "%s").replace("%s", DateUtils.formatElapsedTime(ms / 1000));
            }
        }
        String title = n == 1
            ? titleOf(ctx, items.get(0))
            : str(ctx, "activeCount", "%d").replace("%d", String.valueOf(n));

        NotificationCompat.Builder b = base(ctx)
            .setSmallIcon(paused ? android.R.drawable.stat_sys_download_done : android.R.drawable.stat_sys_download)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(!paused)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setProgress(100, percent, !paused && sum <= 0);
        if (n > 1) {
            NotificationCompat.InboxStyle inbox = new NotificationCompat.InboxStyle().setBigContentTitle(title);
            for (int i = 0; i < Math.min(n, MAX_LINES); i++) {
                Download d = items.get(i);
                inbox.addLine(titleOf(ctx, d) + "  " + Math.round(Math.max(0f, d.getPercentDownloaded())) + "%");
            }
            b.setStyle(inbox);
        } else if (n == 1) {
            b.addAction(paused ? android.R.drawable.ic_media_play : android.R.drawable.ic_media_pause,
                str(ctx, paused ? "resume" : "pause", ""), stopReasonIntent(ctx, items.get(0).request.id, paused));
        }
        return b.build();
    }

    /** Called on every download state change: per-item terminal notification, paused notification. */
    static void onChanged(Context ctx, DownloadManager manager, Download d) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;
        int id = itemId(d.request.id);
        if (d.state == Download.STATE_COMPLETED || d.state == Download.STATE_FAILED) {
            boolean ok = d.state == Download.STATE_COMPLETED;
            nm.notify(id, base(ctx)
                .setSmallIcon(ok ? android.R.drawable.stat_sys_download_done : android.R.drawable.stat_notify_error)
                .setContentTitle(titleOf(ctx, d))
                .setContentText(str(ctx, ok ? "complete" : "failed", ""))
                .setAutoCancel(true)
                .build());
        } else {
            nm.cancel(id);
        }
        refreshPaused(ctx, manager);
    }

    static void onRemoved(Context ctx, DownloadManager manager, Download d) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm != null) nm.cancel(itemId(d.request.id));
        refreshPaused(ctx, manager);
    }

    /** The service stops, taking its notification, once every download is paused; this one stays. */
    static void refreshPaused(Context ctx, DownloadManager manager) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;
        List<Download> downloads = manager.getCurrentDownloads();
        boolean anyPaused = false;
        for (Download d : downloads) {
            if (isActive(d)) {
                nm.cancel(PAUSED_ID);
                return;
            }
            anyPaused |= isPaused(d);
        }
        if (anyPaused) nm.notify(PAUSED_ID, build(ctx, downloads));
        else nm.cancel(PAUSED_ID);
    }

    private static NotificationCompat.Builder base(Context ctx) {
        Intent open = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        return new NotificationCompat.Builder(ctx, FlixDownloadUtil.DOWNLOAD_CHANNEL_ID)
            .setContentIntent(PendingIntent.getActivity(ctx, 0, open, PendingIntent.FLAG_IMMUTABLE))
            .setCategory(NotificationCompat.CATEGORY_PROGRESS);
    }

    private static PendingIntent stopReasonIntent(Context ctx, String id, boolean resume) {
        Intent intent = DownloadService.buildSetStopReasonIntent(
            ctx, FlixDownloadService.class, id,
            resume ? Download.STOP_REASON_NONE : PAUSE_STOP_REASON, /* foreground= */ false);
        return PendingIntent.getService(ctx, itemId(id), intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static boolean isActive(Download d) {
        return d.state == Download.STATE_DOWNLOADING || d.state == Download.STATE_QUEUED
            || d.state == Download.STATE_RESTARTING;
    }

    private static boolean isPaused(Download d) {
        return d.state == Download.STATE_STOPPED && d.stopReason != Download.STOP_REASON_NONE;
    }

    private static int itemId(String id) {
        return 1_000_000 + (id.hashCode() & 0xFFFFF);
    }

    private static String titleOf(Context ctx, Download d) {
        String title = d.request.data.length == 0 ? "" : new String(d.request.data, StandardCharsets.UTF_8);
        return title.isEmpty() ? str(ctx, "channelName", "") : title;
    }

    /** Time left from the progress gained over the last 30 s, summed over the queue; -1 until measurable. */
    private static synchronized long remainingMs(int key, float sum, int n) {
        long now = System.currentTimeMillis();
        if (key != sampleKey) {
            samples.clear();
            sampleKey = key;
        }
        samples.addLast(new long[] {now, Math.round(sum * 100)});
        while (samples.size() > 1 && now - samples.peekFirst()[0] > WINDOW_MS) samples.removeFirst();
        long[] first = samples.peekFirst();
        long span = now - first[0];
        float gained = (sum * 100 - first[1]) / 100f;
        if (span < MIN_SPAN_MS || gained <= 0) return -1;
        return (long) ((100f * n - sum) * span / gained);
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static String str(Context ctx, String key, String fallback) {
        return prefs(ctx).getString(key, fallback);
    }
}
