package com.fliks.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;

/**
 * Foreground Service that keeps the app alive during downloads/transcoding.
 * The foreground notification IS the progress notification — no separate notification.
 * Updated via updateNotification() from the plugin.
 */
public class DownloadForegroundService extends Service {
    private static final String TAG = "DownloadFgService";
    static final String CHANNEL_ID = "fliks_downloads";
    static final int NOTIFICATION_ID = 888888;

    private static DownloadForegroundService instance;
    private boolean started = false;
    private PowerManager.WakeLock wakeLock;

    public static DownloadForegroundService getInstance() {
        return instance;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        ensureChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "STOP".equals(intent.getAction())) {
            releaseWakeLock();
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            instance = null;
            started = false;
            return START_NOT_STICKY;
        }

        if (!started) {
            started = true;
            acquireWakeLock();
            Notification notification = buildNotification("", "", 0, "downloading");
            startForeground(NOTIFICATION_ID, notification);
            Log.d(TAG, "Foreground service started with wake lock");
        }
        // Subsequent startService() calls are no-ops (service already running)
        return START_STICKY;
    }

    /** Called by DownloadNotificationPlugin to update the foreground notification */
    public void updateNotification(String title, String text, int progress, String status) {
        // Renew wake lock on each update to prevent timeout during long transcodes
        renewWakeLock();
        Notification notification = buildNotification(title, text, progress, status);
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.notify(NOTIFICATION_ID, notification);
        }
    }

    private Notification buildNotification(String title, String text, int progress, String status) {
        int color;
        int icon;
        String subText;
        boolean showProgress;
        switch (status) {
            case "transcoding":
                color = Color.parseColor("#2196F3");
                icon = android.R.drawable.ic_popup_sync;
                subText = "⚙ Transcodage";
                showProgress = true;
                break;
            case "downloading":
                color = Color.parseColor("#00BCD4");
                icon = android.R.drawable.stat_sys_download;
                subText = "⬇ Téléchargement";
                showProgress = true;
                break;
            case "complete":
                color = Color.parseColor("#4CAF50");
                icon = android.R.drawable.stat_sys_download_done;
                subText = "✓ Terminé";
                showProgress = false;
                break;
            case "error":
                color = Color.parseColor("#F44336");
                icon = android.R.drawable.stat_notify_error;
                subText = "✗ Échec";
                showProgress = false;
                break;
            default:
                color = Color.parseColor("#2196F3");
                icon = android.R.drawable.stat_sys_download;
                subText = "";
                showProgress = true;
        }

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(icon)
            .setContentTitle(title)
            .setContentText(text)
            .setSubText(subText)
            .setColor(color)
            .setColorized(true)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true);

        if (showProgress && progress >= 0) {
            builder.setProgress(100, progress, false);
        }

        return builder.build();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        releaseWakeLock();
        instance = null;
        Log.d(TAG, "Foreground service stopped");
    }

    /**
     * Partial wake lock: keeps CPU running while screen is off.
     * This prevents Android from suspending the WebView's JavaScript engine,
     * so SSE connections and download progress tracking continue in background.
     * Timeout: 30 minutes max to prevent battery drain if service is never stopped.
     */
    private void acquireWakeLock() {
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "fliks:download");
            wakeLock.acquire(30 * 60 * 1000L); // 30 min timeout
            Log.d(TAG, "Wake lock acquired");
        }
    }

    private void renewWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        acquireWakeLock();
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
            wakeLock = null;
            Log.d(TAG, "Wake lock released");
        }
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Téléchargements",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Progression des téléchargements");
            channel.enableLights(false);
            channel.enableVibration(false);
            channel.setSound(null, null);
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }
}
