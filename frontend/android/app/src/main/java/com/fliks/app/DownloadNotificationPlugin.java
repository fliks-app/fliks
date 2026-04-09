package com.fliks.app;

import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

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

    private static final String TAG = "DownloadNotification";

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
        }

        call.resolve();
    }

    @PluginMethod()
    public void getActiveTasks(PluginCall call) {
        DownloadForegroundService service = DownloadForegroundService.getInstance();
        JSObject result = new JSObject();
        if (service != null) {
            result.put("tasks", service.getActiveTasksJson().toString());
        } else {
            result.put("tasks", "[]");
        }
        call.resolve(result);
    }

    @PluginMethod()
    public void dismiss(PluginCall call) {
        int taskId = call.getInt("id", 0);
        DownloadForegroundService service = DownloadForegroundService.getInstance();
        if (service != null) {
            service.cancelTaskNotification(taskId);
        } else {
            android.app.NotificationManager manager = (android.app.NotificationManager)
                getContext().getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) {
                manager.cancel(DownloadForegroundService.notificationIdForTask(taskId));
            }
        }
        call.resolve();
    }

    @PluginMethod()
    public void dismissAll(PluginCall call) {
        android.app.NotificationManager manager = (android.app.NotificationManager)
            getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.cancelAll();
        }
        call.resolve();
    }

    /**
     * Start service with POLL action — config passed via Intent extras.
     * Service reads config in onStartCommand. No race condition.
     */
    @PluginMethod()
    public void setPollingConfig(PluginCall call) {
        Intent intent = new Intent(getContext(), DownloadForegroundService.class);
        intent.setAction("POLL");
        intent.putExtra("baseUrl", call.getString("baseUrl", ""));
        intent.putExtra("token", call.getString("token", ""));
        intent.putExtra("taskId", call.getInt("taskId", -1));
        intent.putExtra("title", call.getString("title", ""));
        intent.putExtra("episode", call.getString("episode", (String) null));
        intent.putExtra("fileUrl", call.getString("fileUrl", ""));
        intent.putExtra("destPath", call.getString("destPath", ""));
        intent.putExtra("expectedSize", call.getLong("expectedSize", 0L));
        startForegroundServiceCompat(intent);
        call.resolve();
    }

    /**
     * Start service with DOWNLOAD action — config passed via Intent extras.
     */
    @PluginMethod()
    public void nativeDownload(PluginCall call) {
        Intent intent = new Intent(getContext(), DownloadForegroundService.class);
        intent.setAction("DOWNLOAD");
        intent.putExtra("url", call.getString("url", ""));
        intent.putExtra("token", call.getString("token", ""));
        intent.putExtra("destPath", call.getString("destPath", ""));
        intent.putExtra("expectedSize", call.getLong("expectedSize", 0L));
        intent.putExtra("title", call.getString("title", ""));
        intent.putExtra("taskId", call.getInt("taskId", -1));
        startForegroundServiceCompat(intent);
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
        startForegroundServiceCompat(new Intent(getContext(), DownloadForegroundService.class));
        call.resolve();
    }

    @PluginMethod()
    public void stopService(PluginCall call) {
        Intent intent = new Intent(getContext(), DownloadForegroundService.class);
        intent.setAction("STOP");
        getContext().startService(intent);
        call.resolve();
    }

    private void startForegroundServiceCompat(Intent intent) {
        Context ctx = getContext();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ctx.startForegroundService(intent);
        } else {
            ctx.startService(intent);
        }
    }
}
