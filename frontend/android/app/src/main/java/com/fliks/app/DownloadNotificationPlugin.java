package com.fliks.app;

import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.os.Build;

import androidx.core.app.NotificationCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Capacitor plugin for download progress notifications.
 * Bridges Java foreground service ↔ WebView.
 * Per-task notifications: each download gets its own notification ID.
 */
@CapacitorPlugin(name = "DownloadNotification")
public class DownloadNotificationPlugin extends Plugin {

    private static DownloadNotificationPlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    /** Emit event to WebView JS (called from DownloadForegroundService) */
    public static void emitEvent(String eventName, JSObject data) {
        if (instance != null) {
            instance.notifyListeners(eventName, data);
        }
    }

    @PluginMethod()
    public void show(PluginCall call) {
        int taskId = call.getInt("id", 0);
        String title = call.getString("title", "");
        int progress = call.getInt("progress", 0);
        String status = call.getString("status", "downloading");
        String episode = call.getString("episode", null);

        DownloadForegroundService service = DownloadForegroundService.getInstance();
        if (service != null) {
            service.showTaskNotification(taskId, title, progress, status, episode);
        } else {
            showStandaloneNotification(taskId, title, progress, status, episode);
        }

        call.resolve();
    }

    /** Notification before the foreground service starts (replaced once service is up) */
    private void showStandaloneNotification(int taskId, String mediaTitle, int progress, String status, String episode) {
        ensureChannel();

        int color; int icon; String subText; String prefix;
        boolean ongoing; boolean showProg;

        switch (status) {
            case "transcoding":
                color = Color.parseColor("#2196F3");
                icon = android.R.drawable.ic_popup_sync;
                subText = "⚙ Transcodage";
                prefix = progress + "% — ";
                ongoing = true; showProg = true;
                break;
            case "downloading":
                color = Color.parseColor("#00BCD4");
                icon = android.R.drawable.stat_sys_download;
                subText = "⬇ Téléchargement";
                prefix = progress + "% — ";
                ongoing = true; showProg = true;
                break;
            case "complete":
                color = Color.parseColor("#4CAF50");
                icon = android.R.drawable.stat_sys_download_done;
                subText = "✓ Terminé";
                prefix = "Terminé — ";
                ongoing = false; showProg = false;
                break;
            case "error":
                color = Color.parseColor("#F44336");
                icon = android.R.drawable.stat_notify_error;
                subText = "✗ Échec";
                prefix = "Échec — ";
                ongoing = false; showProg = false;
                break;
            default:
                color = Color.parseColor("#2196F3");
                icon = android.R.drawable.stat_sys_download;
                subText = ""; prefix = "";
                ongoing = true; showProg = true;
        }

        Intent launchIntent = getContext().getPackageManager().getLaunchIntentForPackage(getContext().getPackageName());
        android.app.PendingIntent contentIntent = android.app.PendingIntent.getActivity(
            getContext(), 0, launchIntent,
            android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(getContext(), DownloadForegroundService.CHANNEL_ID)
            .setSmallIcon(icon)
            .setContentTitle(prefix + mediaTitle)
            .setSubText(subText)
            .setColor(color)
            .setOngoing(ongoing)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setContentIntent(contentIntent);

        if (episode != null && !episode.isEmpty()) {
            builder.setContentText(episode);
        }
        if (showProg && progress >= 0) {
            builder.setProgress(100, progress, false);
        }
        if (!ongoing) {
            builder.setAutoCancel(true);
        }

        // Same ID as foreground service — will be replaced when service starts
        android.app.NotificationManager manager = (android.app.NotificationManager)
            getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.notify(DownloadForegroundService.NOTIFICATION_ID, builder.build());
        }
    }

    private boolean channelCreated = false;
    private void ensureChannel() {
        if (channelCreated) return;
        channelCreated = true;
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            android.app.NotificationChannel channel = new android.app.NotificationChannel(
                DownloadForegroundService.CHANNEL_ID,
                "Téléchargements",
                android.app.NotificationManager.IMPORTANCE_LOW
            );
            channel.setSound(null, null);
            android.app.NotificationManager manager = getContext().getSystemService(android.app.NotificationManager.class);
            if (manager != null) manager.createNotificationChannel(channel);
        }
    }

    /** Return all active task states from Java service — single source of truth for WebView sync */
    @PluginMethod()
    public void getActiveTasks(PluginCall call) {
        DownloadForegroundService service = DownloadForegroundService.getInstance();
        if (service != null) {
            JSObject result = new JSObject();
            result.put("tasks", service.getActiveTasksJson().toString());
            call.resolve(result);
        } else {
            JSObject result = new JSObject();
            result.put("tasks", "[]");
            call.resolve(result);
        }
    }

    @PluginMethod()
    public void dismiss(PluginCall call) {
        int taskId = call.getInt("id", 0);
        // Remove from service tracking (stops poll + cancels notification)
        DownloadForegroundService service = DownloadForegroundService.getInstance();
        if (service != null) {
            service.cancelTaskNotification(taskId);
        } else {
            // Service not running — cancel notification directly
            android.app.NotificationManager manager = (android.app.NotificationManager)
                getContext().getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) {
                manager.cancel(DownloadForegroundService.NOTIFICATION_ID + Math.abs(taskId));
            }
        }
        call.resolve();
    }

    @PluginMethod()
    public void dismissAll(PluginCall call) {
        stopServiceInternal();
        // Cancel all notifications in the channel
        android.app.NotificationManager manager = (android.app.NotificationManager)
            getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.cancelAll();
        }
        call.resolve();
    }

    @PluginMethod()
    public void nativeDownload(PluginCall call) {
        String url = call.getString("url", "");
        String token = call.getString("token", "");
        String destPath = call.getString("destPath", "");
        long expectedSize = call.getLong("expectedSize", 0L);
        String title = call.getString("title", "");
        int taskId = call.getInt("taskId", -1);

        DownloadForegroundService service = DownloadForegroundService.getInstance();
        if (service != null) {
            service.startNativeDownload(url, token, destPath, expectedSize, title, taskId);
        }
        call.resolve();
    }

    @PluginMethod()
    public void setPollingConfig(PluginCall call) {
        String baseUrl = call.getString("baseUrl", "");
        String token = call.getString("token", "");
        int taskId = call.getInt("taskId", -1);
        String title = call.getString("title", "");
        String episode = call.getString("episode", null);
        String fileUrl = call.getString("fileUrl", "");
        String destPath = call.getString("destPath", "");
        long expectedSize = call.getLong("expectedSize", 0L);
        DownloadForegroundService service = DownloadForegroundService.getInstance();
        if (service != null) {
            service.setPollingConfig(baseUrl, token, taskId, title, episode, fileUrl, destPath, expectedSize);
        }
        call.resolve();
    }

    @PluginMethod()
    public void clearPolling(PluginCall call) {
        DownloadForegroundService service = DownloadForegroundService.getInstance();
        if (service != null) {
            service.clearPolling();
        }
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
