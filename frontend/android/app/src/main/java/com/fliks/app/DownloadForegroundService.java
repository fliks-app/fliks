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
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
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

import com.getcapacitor.JSObject;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Foreground Service for download/transcode progress.
 *
 * One stable notification id per download task: {@link #notificationIdForTask(int)}.
 * The same notification is updated for the whole lifecycle (transcode → download → terminé);
 * we never post a second id for the same media. The foreground binding uses the primary task's id;
 * other tasks use notify() on their id. Placeholder {@link #NOTIFICATION_ID} is cancelled when the
 * first real task binds.
 */
public class DownloadForegroundService extends Service {
    private static final String TAG = "DownloadFgService";
    /** New id so devices get a fresh channel (IMPORTANCE cannot be upgraded on an existing channel). */
    static final String CHANNEL_ID = "fliks_downloads_fgs";
    static final int NOTIFICATION_ID = 888888;
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

        TaskState(int id, String title, String episode, String sortKey) {
            this.id = id; this.title = title; this.episode = episode;
            this.sortKey = sortKey; this.progress = 0; this.status = "transcoding";
        }
    }

    final ConcurrentHashMap<Integer, TaskState> activeTasks = new ConcurrentHashMap<>();
    /** Task IDs currently running a progressive download thread. Prevents duplicates on app resume. */
    private final java.util.Set<Integer> progressiveRunning = java.util.Collections.synchronizedSet(new java.util.HashSet<>());
    private volatile int primaryTaskId = -1;
    private int taskCounter = 0;

    private volatile String serverBaseUrl;
    private volatile String authToken;

    public static DownloadForegroundService getInstance() { return instance; }

    /** Stable notification id for a download task (shared with {@link DownloadNotificationPlugin}). */
    public static int notificationIdForTask(int taskId) {
        return NOTIFICATION_ID + taskId;
    }

    private int notifId(int tid) {
        return notificationIdForTask(tid);
    }

    private void runOnMain(Runnable r) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            r.run();
        } else {
            new Handler(Looper.getMainLooper()).post(r);
        }
    }

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
        if (intent != null && "REPOST".equals(intent.getAction())) {
            // User swiped the notification (Samsung One UI) — re-post it immediately
            if (primaryTaskId > 0) {
                updateSingleNotification(primaryTaskId);
            }
            return START_STICKY;
        }

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
            startForeground(NOTIFICATION_ID, buildTaskNotification(null, "Téléchargement", 0, "downloading", null));
            Log.d(TAG, "Foreground service started");
        }

        if (intent != null && "PROGRESSIVE_DOWNLOAD".equals(intent.getAction())) {
            doProgressiveDownload(
                intent.getStringExtra("baseUrl"),
                intent.getStringExtra("token"),
                intent.getIntExtra("taskId", -1),
                intent.getStringExtra("destDir"),
                intent.getStringExtra("title"),
                intent.getStringExtra("episode"),
                intent.getFloatExtra("segmentDuration", 3.0f)
            );
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
                final TaskState bound = ts;
                runOnMain(() -> {
                    NotificationManagerCompat.from(DownloadForegroundService.this).cancel(NOTIFICATION_ID);
                    startForeground(notifId(tid), buildTaskNotification(bound.sortKey, title, 0, bound.status, episode));
                });
            }
        } else {
            if (title != null && !title.isEmpty()) ts.title = title;
            if (episode != null) ts.episode = episode;
            // Reset error tasks so retry works (re-enters transcoding/downloading flow)
            if ("error".equals(ts.status)) {
                ts.status = "transcoding";
                ts.progress = 0;
            }
        }
        return ts;
    }

    // ===== PUBLIC API =====

    public void clearPolling() {}

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
        runOnMain(() -> {
            boolean wasPrimary = (tid == primaryTaskId);
            activeTasks.remove(tid);
            NotificationManagerCompat.from(DownloadForegroundService.this).cancel(notifId(tid));
            if (wasPrimary) promoteOrStop();
        });
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

    /**
     * Publish current {@link TaskState} for this task. Primary task updates the foreground
     * notification in place ({@link #startForeground}); others use {@code notify} on the same stable id.
     */
    private void updateSingleNotification(int tid) {
        runOnMain(() -> {
            TaskState ts = activeTasks.get(tid);
            if (ts == null) return;
            Notification n = buildTaskNotification(ts.sortKey, ts.title, ts.progress, ts.status, ts.episode);
            int nid = notifId(tid);
            if (tid == primaryTaskId) {
                startForeground(nid, n);
            } else {
                NotificationManagerCompat.from(DownloadForegroundService.this).notify(nid, n);
            }
        });
    }

    /**
     * Handle task completion/failure (main thread).
     * Updates the existing notification in place: startForeground(sameId, terminal) then DETACH,
     * so the system keeps one notification that morphs from ongoing → Terminé (notify-after-detach
     * was unreliable on some devices when stopSelf() followed immediately).
     */
    private void postTerminal(int tid, String title, String status, String episode) {
        // if (Looper.myLooper() != Looper.getMainLooper()) {
        //     new Handler(Looper.getMainLooper()).post(() -> postTerminal(tid, title, status, episode));
        //     return;
        // }
        boolean wasPrimary = (tid == primaryTaskId);
        TaskState ts = activeTasks.get(tid);
        NotificationManagerCompat nm = NotificationManagerCompat.from(this);
        int nid = notifId(tid);

        Notification termNotif;
        if (ts != null) {
            if (title != null && !title.isEmpty()) ts.title = title;
            if (episode != null) ts.episode = episode;
            ts.status = status;
            ts.progress = 0;
            termNotif = buildTaskNotification(ts.sortKey, ts.title, ts.progress, ts.status, ts.episode);
        } else {
            termNotif = buildTaskNotification(null, title, 0, status, episode);
        }

        if (wasPrimary) {
            startForeground(nid, termNotif);
            stopForeground(STOP_FOREGROUND_DETACH);
        } else {
            nm.notify(nid, termNotif);
        }

        if ("error".equals(status)) {
            // Keep error tasks in activeTasks so getActiveTasks() reports them to the UI.
            // They are removed on retry (ensureTask resets) or delete (cancelTaskNotification).
            if (wasPrimary) promoteOrStop();
        } else {
            activeTasks.remove(tid);
            if (wasPrimary) promoteOrStop();
        }
    }

    /** Promote another active (non-error) task as foreground, or stop service */
    private void promoteOrStop() {
        // Find a non-error task to promote
        int nextId = -1;
        for (TaskState ts : activeTasks.values()) {
            if (!"error".equals(ts.status)) {
                nextId = ts.id;
                break;
            }
        }
        if (nextId < 0) {
            // Only error tasks remain — service can stop (error notifications are detached)
            primaryTaskId = -1;
            stopSelf();
        } else {
            primaryTaskId = nextId;
            TaskState next = activeTasks.get(primaryTaskId);
            if (next != null) {
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

    private void stopPolling() {
        if (pollFuture != null) { pollFuture.cancel(false); pollFuture = null; }
    }

    // ===== PROGRESSIVE DOWNLOAD =====

    /**
     * Download HLS segments incrementally as they are transcoded on the server.
     * Polls /api/downloads/{id}/status to discover new segments, downloads each
     * one sequentially, and generates a local index.m3u8 when done.
     */
    private void doProgressiveDownload(String baseUrl, String token, int taskId,
                                        String destDir, String title, String episode,
                                        float segDuration) {
        if (progressiveRunning.contains(taskId)) {
            Log.d(TAG, "Progressive #" + taskId + ": already running, skipping duplicate");
            return;
        }
        this.serverBaseUrl = baseUrl;
        this.authToken = token;
        Log.d(TAG, "Progressive #" + taskId + ": title=\"" + title + "\", episode=\"" + episode + "\", destDir=" + destDir);
        TaskState ts = ensureTask(taskId, title, episode);
        ts.status = "downloading";
        updateSingleNotification(taskId);
        progressiveRunning.add(taskId);

        downloadExecutor.submit(() -> {
            int nextSeg = -1; // -1 = init.mp4 not yet downloaded
            try {
                java.io.File dir = new java.io.File(destDir);
                if (!dir.exists()) dir.mkdirs();

                while (true) {
                    // Poll status
                    String statusUrl = baseUrl + "/api/downloads/" + taskId + "/status";
                    JSONObject st = httpGetJson(statusUrl, token);
                    int available = st.optInt("segmentCount", 0);
                    boolean done = st.optBoolean("done", false);
                    int total = st.optInt("totalSegments", 0);

                    // Download init.mp4 first
                    if (nextSeg == -1) {
                        if (available > 0 || done) {
                            downloadSegment(baseUrl, token, taskId, "init.mp4", destDir);
                            nextSeg = 0;
                        }
                    }

                    // Download newly available segments
                    while (nextSeg >= 0 && nextSeg < available) {
                        String segName = String.format("seg-%04d.m4s", nextSeg);
                        downloadSegment(baseUrl, token, taskId, segName, destDir);
                        nextSeg++;

                        int pct = total > 0 ? Math.min(99, (nextSeg * 100) / total) : 0;
                        if (pct != ts.progress) {
                            Log.d(TAG, "Progressive #" + taskId + ": " + pct + "% (" + nextSeg + "/" + total + " segments)");
                        }
                        ts.progress = pct;
                        ts.status = "downloading";
                        updateSingleNotification(taskId);
                        emitToWebView("downloadProgress", taskId, pct, "downloading");
                    }

                    if (done && nextSeg >= available) {
                        // All segments downloaded — generate local manifest
                        generateLocalManifest(destDir, nextSeg, segDuration);

                        ts.progress = 100;
                        ts.status = "downloading";
                        updateSingleNotification(taskId);
                        emitToWebView("downloadProgress", taskId, 100, "downloading");
                        try { Thread.sleep(1000); } catch (InterruptedException ignored) {}
                        emitToWebView("downloadComplete", taskId, 100, "complete");
                        postTerminal(taskId, title, "complete", episode);
                        return;
                    }

                    // Wait before next poll
                    Thread.sleep(2000);
                }
            } catch (Exception e) {
                Log.w(TAG, "Progressive download #" + taskId + " failed: " + e.getMessage());
                emitToWebView("downloadFailed", taskId, 0, "error");
                postTerminal(taskId, title, "error", episode);
            } finally {
                progressiveRunning.remove(taskId);
            }
        });
    }

    private void downloadSegment(String baseUrl, String token, int taskId,
                                  String filename, String destDir) throws Exception {
        String url = baseUrl + "/api/downloads/" + taskId + "/segment/" + filename;
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setRequestMethod("GET");
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(60000);
        if (token != null && !token.isEmpty()) {
            conn.setRequestProperty("Authorization", "Bearer " + token);
        }
        int code = conn.getResponseCode();
        if (code != 200) throw new Exception("Segment " + filename + " HTTP " + code);
        java.io.InputStream in = conn.getInputStream();
        java.io.FileOutputStream out = new java.io.FileOutputStream(destDir + "/" + filename);
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
        out.close();
        in.close();
        conn.disconnect();
    }

    private JSONObject httpGetJson(String urlStr, String token) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
        conn.setRequestMethod("GET");
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(10000);
        if (token != null && !token.isEmpty()) {
            conn.setRequestProperty("Authorization", "Bearer " + token);
        }
        int code = conn.getResponseCode();
        if (code != 200) throw new Exception("Status poll HTTP " + code);
        BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream()));
        StringBuilder sb = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) sb.append(line);
        reader.close();
        conn.disconnect();
        return new JSONObject(sb.toString());
    }

    private void generateLocalManifest(String destDir, int segmentCount, float segDuration) throws Exception {
        StringBuilder m3u8 = new StringBuilder();
        m3u8.append("#EXTM3U\n");
        m3u8.append("#EXT-X-VERSION:7\n");
        m3u8.append("#EXT-X-TARGETDURATION:").append((int) Math.ceil(segDuration)).append("\n");
        m3u8.append("#EXT-X-MEDIA-SEQUENCE:0\n");
        m3u8.append("#EXT-X-PLAYLIST-TYPE:VOD\n");
        m3u8.append("#EXT-X-MAP:URI=\"init.mp4\"\n");
        for (int i = 0; i < segmentCount; i++) {
            m3u8.append(String.format("#EXTINF:%.3f,\n", segDuration));
            m3u8.append(String.format("seg-%04d.m4s\n", i));
        }
        m3u8.append("#EXT-X-ENDLIST\n");
        java.io.FileWriter fw = new java.io.FileWriter(destDir + "/index.m3u8");
        fw.write(m3u8.toString());
        fw.close();
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
        boolean showProgress;

        switch (status != null ? status : "") {
            case "transcoding": case "downloading":
                color = Color.parseColor("#00BCD4");
                icon = android.R.drawable.stat_sys_download;
                subText = "⬇ Téléchargement";
                prefix = progress + "% — ";
                showProgress = true;
                break;
            case "complete":
                color = Color.parseColor("#4CAF50");
                icon = android.R.drawable.stat_sys_download_done;
                subText = "✓ Terminé";
                prefix = "Terminé — ";
                showProgress = false;
                break;
            case "error":
                color = Color.parseColor("#F44336");
                icon = android.R.drawable.stat_notify_error;
                subText = "✗ Échec";
                prefix = "Échec — ";
                showProgress = false;
                break;
            default:
                color = Color.parseColor("#2196F3");
                icon = android.R.drawable.stat_sys_download;
                subText = ""; prefix = "";
                showProgress = true;
        }

        // Ongoing + no autoCancel.
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(icon)
            .setContentTitle(prefix + (mediaTitle != null ? mediaTitle : ""))
            .setSubText(subText)
            .setColor(color)
            .setCategory(Notification.CATEGORY_PROGRESS)
            .setOngoing(true)
            .setAutoCancel(false)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(getLaunchIntent())
            .setDeleteIntent(getRepostIntent());

        if (sortKey != null) builder.setSortKey(sortKey);
        if (episode != null && !episode.isEmpty()) builder.setContentText(episode);
        if (showProgress && progress >= 0) {
            builder.setProgress(100, progress, false);
        }
        if (!showProgress) {
            // Remove progress bar when switching to terminal state (complete / error).
            builder.setProgress(0, 0, false);
        }

        Notification n = builder.build();
        n.flags |= Notification.FLAG_ONGOING_EVENT | Notification.FLAG_NO_CLEAR;
        return n;
    }

    Notification buildTaskNotification(String mediaTitle, int progress, String status, String episode) {
        return buildTaskNotification(null, mediaTitle, progress, status, episode);
    }

    private PendingIntent getLaunchIntent() {
        Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        return PendingIntent.getActivity(this, 0, launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** PendingIntent that re-posts the notification when Samsung One UI allows user to swipe it */
    private PendingIntent getRepostIntent() {
        Intent intent = new Intent(this, DownloadForegroundService.class);
        intent.setAction("REPOST");
        return PendingIntent.getService(this, 1, intent,
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
                CHANNEL_ID, "Téléchargements", NotificationManager.IMPORTANCE_DEFAULT);
            channel.setDescription("Progression des téléchargements");
            channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            channel.enableLights(false);
            channel.enableVibration(false);
            channel.setSound(null, null);
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) manager.createNotificationChannel(channel);
        }
    }
}
