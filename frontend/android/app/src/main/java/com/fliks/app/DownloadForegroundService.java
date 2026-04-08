package com.fliks.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

import com.getcapacitor.JSObject;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Foreground Service for download/transcode progress.
 *
 * Each task has a STABLE notification ID: NOTIFICATION_ID + taskId.
 * The foreground service is bound to one of them (the primary).
 * When primary completes, another task is promoted via startForeground(newId).
 */
public class DownloadForegroundService extends Service {
    private static final String TAG = "DownloadFgService";
    static final String CHANNEL_ID = "fliks_downloads";
    static final int NOTIFICATION_ID = 888888;
    private static final String GROUP_KEY = "fliks_downloads";
    private static final long POLL_INTERVAL_SECONDS = 5;

    private static DownloadForegroundService instance;
    private boolean started = false;
    private PowerManager.WakeLock wakeLock;
    private ScheduledExecutorService pollExecutor;
    private java.util.concurrent.ExecutorService downloadExecutor;
    private ScheduledFuture<?> pollFuture;

    static class TaskState {
        final int id;
        final String sortKey;
        volatile String title;
        volatile String episode;
        volatile int progress;
        volatile String status;
        String fileUrl;
        String destPath;
        long expectedSize;

        TaskState(int id, String title, String episode, String sortKey) {
            this.id = id; this.title = title; this.episode = episode;
            this.sortKey = sortKey; this.progress = 0; this.status = "transcoding";
        }
    }

    final ConcurrentHashMap<Integer, TaskState> activeTasks = new ConcurrentHashMap<>();
    private volatile int primaryTaskId = -1;
    private int taskCounter = 0;

    private volatile String serverBaseUrl;
    private volatile String authToken;
    private volatile boolean downloading = false;
    private volatile int downloadTaskId = -1;

    public static DownloadForegroundService getInstance() { return instance; }

    /** Stable notification ID for a task */
    private int notifId(int tid) { return NOTIFICATION_ID + tid; }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        ensureChannel();
        pollExecutor = Executors.newSingleThreadScheduledExecutor();
        downloadExecutor = Executors.newCachedThreadPool();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "STOP".equals(intent.getAction())) {
            stopPolling();
            releaseWakeLock();
            cancelAllNotifications();
            activeTasks.clear();
            primaryTaskId = -1;
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            instance = null;
            started = false;
            return START_NOT_STICKY;
        }

        if (!started) {
            started = true;
            acquireWakeLock();
            // Placeholder — replaced by first updateSingleNotification call
            startForeground(NOTIFICATION_ID, buildTaskNotification(null, "Téléchargement", 0, "downloading", null));
            startPolling();
            Log.d(TAG, "Foreground service started");
        }
        return START_STICKY;
    }

    // ===== TASK MANAGEMENT =====

    private TaskState ensureTask(int tid, String title, String episode) {
        TaskState ts = activeTasks.get(tid);
        if (ts == null) {
            ts = new TaskState(tid, title, episode, String.format("%06d", taskCounter++));
            activeTasks.put(tid, ts);
            // First task or new task: set as primary if needed
            if (primaryTaskId == -1) {
                primaryTaskId = tid;
                // Rebind foreground to this task's notification ID
                startForeground(notifId(tid), buildTaskNotification(ts.sortKey, title, 0, ts.status, episode));
            }
        } else {
            if (title != null && !title.isEmpty()) ts.title = title;
            if (episode != null) ts.episode = episode;
        }
        return ts;
    }

    // ===== PUBLIC API =====

    public void setPollingConfig(String baseUrl, String token, int taskId, String title,
                                  String episode, String fileUrl, String destPath, long expectedSize) {
        this.serverBaseUrl = baseUrl;
        this.authToken = token;
        TaskState ts = ensureTask(taskId, title, episode);
        ts.fileUrl = fileUrl;
        ts.destPath = destPath;
        ts.expectedSize = expectedSize;
        updateSingleNotification(taskId);
        Log.d(TAG, "Polling config: task #" + taskId + " — " + title);
    }

    public void clearPolling() {}
    public void setDownloadTaskId(int id) { this.downloadTaskId = id; }

    public void setEpisode(String episode) {
        if (downloadTaskId > 0) {
            TaskState ts = activeTasks.get(downloadTaskId);
            if (ts != null) ts.episode = episode;
        }
    }

    public void showTaskNotification(int tid, String title, int progress, String status, String episode) {
        renewWakeLock();
        TaskState ts = ensureTask(tid, title, episode);
        ts.progress = progress;
        ts.status = status;
        if ("complete".equals(status) || "error".equals(status)) {
            postTerminal(tid, title, status, episode);
        } else {
            updateSingleNotification(tid);
        }
    }

    public void cancelTaskNotification(int tid) {
        boolean wasPrimary = (tid == primaryTaskId);
        activeTasks.remove(tid);
        NotificationManagerCompat.from(this).cancel(notifId(tid));
        if (wasPrimary) promoteOrStop();
    }

    public void startNativeDownload(String url, String token, String destPath,
                                     long expectedSize, String title, int taskId) {
        this.authToken = token;
        this.downloadTaskId = taskId;
        TaskState ts = ensureTask(taskId, title, null);
        ts.status = "downloading";
        ts.fileUrl = url;
        ts.destPath = destPath;
        ts.expectedSize = expectedSize;
        this.downloading = true;
        updateSingleNotification(taskId);
        downloadExecutor.submit(() -> doDownload(url, token, destPath, expectedSize, title, taskId));
    }

    public JSONArray getActiveTasksJson() {
        JSONArray arr = new JSONArray();
        for (TaskState ts : activeTasks.values()) {
            try {
                JSONObject obj = new JSONObject();
                obj.put("taskId", ts.id);
                obj.put("progress", ts.progress);
                obj.put("status", ts.status);
                arr.put(obj);
            } catch (Exception ignored) {}
        }
        return arr;
    }

    // ===== NOTIFICATIONS =====

    /** Update a single task's notification */
    private void updateSingleNotification(int tid) {
        TaskState ts = activeTasks.get(tid);
        if (ts == null) return;
        NotificationManagerCompat.from(this).notify(
            notifId(tid),
            buildTaskNotification(ts.sortKey, ts.title, ts.progress, ts.status, ts.episode));
    }

    /** Handle task completion/failure */
    private void postTerminal(int tid, String title, String status, String episode) {
        boolean wasPrimary = (tid == primaryTaskId);
        TaskState old = activeTasks.get(tid);
        String sortKey = old != null ? old.sortKey : null;
        activeTasks.remove(tid);

        NotificationManagerCompat nm = NotificationManagerCompat.from(this);
        Notification termNotif = buildTaskNotification(sortKey, title, 0, status, episode);

        if (wasPrimary) {
            // Detach foreground FIRST so notification can become ongoing=false
            stopForeground(STOP_FOREGROUND_DETACH);
            // Replace with terminal notification (now dismissible)
            nm.notify(notifId(tid), termNotif);
            // Promote another task or stop
            promoteOrStop();
        } else {
            nm.notify(notifId(tid), termNotif);
        }
    }

    /** Promote another active task as foreground, or stop service */
    private void promoteOrStop() {
        if (activeTasks.isEmpty()) {
            primaryTaskId = -1;
            stopSelf();
        } else {
            primaryTaskId = activeTasks.keySet().iterator().next();
            TaskState next = activeTasks.get(primaryTaskId);
            if (next != null) {
                // startForeground rebinds the service to this notification ID
                startForeground(notifId(primaryTaskId),
                    buildTaskNotification(next.sortKey, next.title, next.progress, next.status, next.episode));
            }
        }
    }

    private void cancelAllNotifications() {
        NotificationManagerCompat nm = NotificationManagerCompat.from(this);
        nm.cancel(NOTIFICATION_ID);
        for (int tid : activeTasks.keySet()) nm.cancel(notifId(tid));
    }

    // ===== POLLING =====

    private void startPolling() {
        if (pollFuture != null) return;
        pollFuture = pollExecutor.scheduleAtFixedRate(this::poll, POLL_INTERVAL_SECONDS, POLL_INTERVAL_SECONDS, TimeUnit.SECONDS);
    }

    private void stopPolling() {
        if (pollFuture != null) { pollFuture.cancel(false); pollFuture = null; }
    }

    private void poll() {
        String baseUrl = this.serverBaseUrl;
        String token = this.authToken;
        if (baseUrl == null || activeTasks.isEmpty()) return;

        boolean needsPoll = false;
        for (TaskState ts : activeTasks.values()) {
            if ("transcoding".equals(ts.status) || "remuxing".equals(ts.status)) {
                needsPoll = true; break;
            }
        }
        if (!needsPoll) return;

        try {
            HttpURLConnection conn = (HttpURLConnection) new URL(baseUrl + "/api/downloads").openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(5000);
            if (token != null && !token.isEmpty()) {
                conn.setRequestProperty("Authorization", "Bearer " + token);
            }

            if (conn.getResponseCode() == 200) {
                BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream()));
                StringBuilder sb = new StringBuilder();
                String line;
                while ((line = reader.readLine()) != null) sb.append(line);
                reader.close();

                JSONArray tasks = new JSONArray(sb.toString());
                for (int i = 0; i < tasks.length(); i++) {
                    JSONObject json = tasks.getJSONObject(i);
                    int tid = json.optInt("id", -1);
                    TaskState ts = activeTasks.get(tid);
                    if (ts == null) continue;

                    String status = json.optString("status", "");
                    int progress = json.optInt("progress", 0);
                    Log.d(TAG, "Poll: #" + tid + " " + status + " " + progress + "%");

                    if ("transcoding".equals(status) || "remuxing".equals(status)) {
                        ts.progress = progress;
                        ts.status = status;
                        updateSingleNotification(tid);
                        emitToWebView("downloadProgress", tid, progress, status);
                    } else if ("ready".equals(status)
                            && ("transcoding".equals(ts.status) || "remuxing".equals(ts.status))) {
                        emitToWebView("downloadReady", tid, 100, "ready");
                        if (ts.fileUrl != null && ts.destPath != null && !ts.destPath.isEmpty()) {
                            Log.d(TAG, "Task #" + tid + " ready — chaining to download");
                            ts.progress = 0;
                            ts.status = "downloading";
                            updateSingleNotification(tid);
                            this.downloadTaskId = tid;
                            this.downloading = true;
                            downloadExecutor.submit(() -> doDownload(
                                ts.fileUrl, this.authToken, ts.destPath, ts.expectedSize, ts.title, tid));
                        }
                    } else if ("failed".equals(status)) {
                        emitToWebView("downloadFailed", tid, 0, "failed");
                        postTerminal(tid, ts.title, "error", ts.episode);
                    }
                }
            }
            conn.disconnect();
        } catch (Exception e) {
            Log.w(TAG, "Poll error: " + e.getMessage());
        }
    }

    // ===== NATIVE DOWNLOAD =====

    private void doDownload(String url, String authToken, String destPath,
                             long expectedSize, String title, int tid) {
        TaskState ts = activeTasks.get(tid);
        String episode = ts != null ? ts.episode : null;

        try {
            HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(60000);
            if (authToken != null && !authToken.isEmpty()) {
                conn.setRequestProperty("Authorization", "Bearer " + authToken);
            }

            int code = conn.getResponseCode();
            if (code != 200) {
                Log.w(TAG, "Download HTTP " + code);
                downloading = false;
                emitToWebView("downloadFailed", tid, 0, "error");
                postTerminal(tid, title, "error", episode);
                return;
            }

            long contentLength = conn.getContentLengthLong();
            Log.d(TAG, "Download #" + tid + ": contentLength=" + contentLength + ", expectedSize=" + expectedSize);
            if (contentLength <= 0) contentLength = expectedSize;

            java.io.InputStream in = conn.getInputStream();
            java.io.FileOutputStream out = new java.io.FileOutputStream(destPath);
            byte[] buffer = new byte[8192];
            long downloaded = 0;
            int lastPct = -1;
            long lastNotifTime = 0;
            int bytesRead;

            while ((bytesRead = in.read(buffer)) != -1) {
                out.write(buffer, 0, bytesRead);
                downloaded += bytesRead;
                if (contentLength > 0) {
                    int pct = (int) (downloaded * 100 / contentLength);
                    if (pct != lastPct) {
                        lastPct = pct;
                        if (ts != null) { ts.progress = pct; ts.status = "downloading"; }
                        long now = System.currentTimeMillis();
                        if (now - lastNotifTime >= 250) {
                            lastNotifTime = now;
                            updateSingleNotification(tid);
                            emitToWebView("downloadProgress", tid, pct, "downloading");
                        }
                    }
                }
            }

            out.close();
            in.close();
            conn.disconnect();
            downloading = false;

            Log.d(TAG, "Download complete: " + destPath + " (" + downloaded + " bytes)");
            emitToWebView("downloadComplete", tid, 100, "complete");
            postTerminal(tid, title, "complete", episode);
        } catch (Exception e) {
            downloading = false;
            Log.w(TAG, "Download failed: " + e.getMessage());
            emitToWebView("downloadFailed", tid, 0, "error");
            postTerminal(tid, title, "error", episode);
        }
    }

    // ===== EVENT BRIDGE =====

    private void emitToWebView(String event, int taskId, int progress, String status) {
        try {
            JSObject data = new JSObject();
            data.put("taskId", taskId);
            data.put("progress", progress);
            data.put("status", status);
            DownloadNotificationPlugin.emitEvent(event, data);
        } catch (Exception e) {
            Log.w(TAG, "emitToWebView failed: " + e.getMessage());
        }
    }

    // ===== NOTIFICATION BUILDER =====

    Notification buildTaskNotification(String sortKey, String mediaTitle, int progress, String status, String episode) {
        int color; int icon; String subText; String prefix;
        boolean ongoing; boolean showProgress;

        switch (status != null ? status : "") {
            case "transcoding": case "remuxing":
                color = Color.parseColor("#2196F3");
                icon = android.R.drawable.ic_popup_sync;
                subText = "⚙ Transcodage";
                prefix = progress + "% — ";
                ongoing = true; showProgress = true;
                break;
            case "downloading":
                color = Color.parseColor("#00BCD4");
                icon = android.R.drawable.stat_sys_download;
                subText = "⬇ Téléchargement";
                prefix = progress + "% — ";
                ongoing = true; showProgress = true;
                break;
            case "complete":
                color = Color.parseColor("#4CAF50");
                icon = android.R.drawable.stat_sys_download_done;
                subText = "✓ Terminé";
                prefix = "Terminé — ";
                ongoing = false; showProgress = false;
                break;
            case "error":
                color = Color.parseColor("#F44336");
                icon = android.R.drawable.stat_notify_error;
                subText = "✗ Échec";
                prefix = "Échec — ";
                ongoing = false; showProgress = false;
                break;
            default:
                color = Color.parseColor("#2196F3");
                icon = android.R.drawable.stat_sys_download;
                subText = ""; prefix = "";
                ongoing = true; showProgress = true;
        }

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(icon)
            .setContentTitle(prefix + (mediaTitle != null ? mediaTitle : ""))
            .setSubText(subText)
            .setColor(color)
            .setOngoing(ongoing)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setGroup(GROUP_KEY)
            .setContentIntent(getLaunchIntent());

        if (sortKey != null) builder.setSortKey(sortKey);
        if (episode != null && !episode.isEmpty()) builder.setContentText(episode);
        if (showProgress && progress >= 0) builder.setProgress(100, progress, false);
        if (!ongoing) builder.setAutoCancel(true);

        return builder.build();
    }

    // Convenience for places that don't have a sortKey
    Notification buildTaskNotification(String mediaTitle, int progress, String status, String episode) {
        return buildTaskNotification(null, mediaTitle, progress, status, episode);
    }

    private PendingIntent getLaunchIntent() {
        Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        return PendingIntent.getActivity(this, 0, launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    // ===== LIFECYCLE =====

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onDestroy() {
        super.onDestroy();
        stopPolling();
        if (pollExecutor != null) { pollExecutor.shutdownNow(); pollExecutor = null; }
        if (downloadExecutor != null) { downloadExecutor.shutdownNow(); downloadExecutor = null; }
        releaseWakeLock();
        instance = null;
        Log.d(TAG, "Service destroyed");
    }

    private void acquireWakeLock() {
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "fliks:download");
            wakeLock.acquire(60 * 60 * 1000L);
        }
    }

    private void renewWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        acquireWakeLock();
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) { wakeLock.release(); wakeLock = null; }
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "Téléchargements", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Progression des téléchargements");
            channel.enableLights(false);
            channel.enableVibration(false);
            channel.setSound(null, null);
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) manager.createNotificationChannel(channel);
        }
    }
}
