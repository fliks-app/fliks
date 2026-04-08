package com.fliks.app;

import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.os.Build;

import androidx.core.app.NotificationCompat;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Capacitor plugin for download progress notifications.
 * Uses the DownloadForegroundService's notification — single notification for all downloads.
 * No separate per-task notifications.
 */
@CapacitorPlugin(name = "DownloadNotification")
public class DownloadNotificationPlugin extends Plugin {

    private static final int STANDALONE_NOTIF_ID = 777777;

    @PluginMethod()
    public void show(PluginCall call) {
        String title = call.getString("title", "");
        String text = call.getString("text", "");
        int progress = call.getInt("progress", 0);
        String status = call.getString("status", "downloading");

        // Terminal states (complete/error): show standalone notification (no service needed)
        if ("complete".equals(status) || "error".equals(status)) {
            showStandaloneNotification(title, text, status);
            call.resolve();
            return;
        }

        // In-progress: update the foreground service notification
        DownloadForegroundService service = DownloadForegroundService.getInstance();
        if (service != null) {
            service.updateNotification(title, text, progress, status);
        }

        call.resolve();
    }

    private void showStandaloneNotification(String title, String text, String status) {
        int color;
        int icon;
        String subText;
        if ("complete".equals(status)) {
            color = Color.parseColor("#4CAF50");
            icon = android.R.drawable.stat_sys_download_done;
            subText = "✓ Terminé";
        } else {
            color = Color.parseColor("#F44336");
            icon = android.R.drawable.stat_notify_error;
            subText = "✗ Échec";
        }

        Context ctx = getContext();
        NotificationCompat.Builder builder = new NotificationCompat.Builder(ctx, DownloadForegroundService.CHANNEL_ID)
            .setSmallIcon(icon)
            .setContentTitle(title)
            .setContentText(text)
            .setSubText(subText)
            .setColor(color)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true);

        if ("complete".equals(status)) {
            builder.setTimeoutAfter(5000);
        }

        NotificationManager manager = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            // Use title hash as ID so multiple standalone notifs can coexist
            manager.notify(STANDALONE_NOTIF_ID + title.hashCode() % 10000, builder.build());
        }
    }

    @PluginMethod()
    public void dismiss(PluginCall call) {
        // No-op — notification is managed by the foreground service
        call.resolve();
    }

    @PluginMethod()
    public void dismissAll(PluginCall call) {
        // Stop the service which removes its notification
        stopServiceInternal();
        call.resolve();
    }

    @PluginMethod()
    public void startService(PluginCall call) {
        Context ctx = getContext();
        Intent intent = new Intent(ctx, DownloadForegroundService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ctx.startForegroundService(intent);
        } else {
            ctx.startService(intent);
        }
        call.resolve();
    }

    @PluginMethod()
    public void stopService(PluginCall call) {
        stopServiceInternal();
        call.resolve();
    }

    private void stopServiceInternal() {
        Context ctx = getContext();
        Intent intent = new Intent(ctx, DownloadForegroundService.class);
        intent.setAction("STOP");
        ctx.startService(intent);
    }
}
