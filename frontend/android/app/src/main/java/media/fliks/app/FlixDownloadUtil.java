package media.fliks.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.graphics.Color;
import android.os.Build;
import android.util.Log;

import androidx.annotation.OptIn;
import androidx.core.app.NotificationCompat;
import com.getcapacitor.JSObject;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.database.StandaloneDatabaseProvider;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.cache.CacheDataSource;
import androidx.media3.datasource.cache.NoOpCacheEvictor;
import androidx.media3.datasource.cache.SimpleCache;
import androidx.media3.exoplayer.offline.Download;
import androidx.media3.exoplayer.offline.DownloadManager;
import androidx.media3.exoplayer.offline.DownloadNotificationHelper;
import androidx.media3.exoplayer.offline.DownloadRequest;
import androidx.media3.exoplayer.offline.DownloadService;

import java.io.File;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.Executors;

/**
 * Singleton utilities for ExoPlayer offline downloads.
 * Provides the shared {@link SimpleCache}, {@link DownloadManager}, and
 * {@link CacheDataSource.Factory} used across the app.
 */
@OptIn(markerClass = UnstableApi.class)
public class FlixDownloadUtil {
    private static final String TAG = "FlixDownloadUtil";
    static final String DOWNLOAD_CHANNEL_ID = "fliks_downloads";
    static final int FOREGROUND_NOTIFICATION_ID = 888888;

    private static SimpleCache cache;
    private static DownloadManager downloadManager;
    private static DownloadNotificationHelper notificationHelper;
    private static String authToken;

    public static synchronized void setAuthToken(String token) {
        authToken = token;
    }

    public static synchronized SimpleCache getCache(Context ctx) {
        if (cache == null) {
            File cacheDir = new File(ctx.getFilesDir(), "fliks-offline");
            cache = new SimpleCache(
                cacheDir,
                new NoOpCacheEvictor(),
                new StandaloneDatabaseProvider(ctx)
            );
        }
        return cache;
    }

    public static synchronized DownloadManager getDownloadManager(Context ctx) {
        if (downloadManager == null) {
            ensureChannel(ctx);
            downloadManager = new DownloadManager(
                ctx,
                new StandaloneDatabaseProvider(ctx),
                getCache(ctx),
                buildHttpDataSourceFactory(),
                Executors.newFixedThreadPool(2)
            );
            downloadManager.setMaxParallelDownloads(2);
            // Emit progress/completion events to WebView — registered once on
            // the singleton so events flow regardless of service lifecycle.
            downloadManager.addListener(new DownloadManager.Listener() {
                @Override
                public void onDownloadChanged(DownloadManager manager, Download download, Exception finalException) {
                    JSObject data = new JSObject();
                    data.put("id", download.request.id);
                    data.put("progress", Math.round(download.getPercentDownloaded()));
                    String state;
                    switch (download.state) {
                        case Download.STATE_COMPLETED: state = "completed"; break;
                        case Download.STATE_FAILED: state = "failed"; break;
                        case Download.STATE_DOWNLOADING: state = "downloading"; break;
                        default: state = "queued";
                    }
                    data.put("state", state);
                    if (download.state == Download.STATE_COMPLETED) {
                        DownloadNotificationPlugin.emitEvent("downloadComplete", data);
                    } else if (download.state == Download.STATE_FAILED) {
                        DownloadNotificationPlugin.emitEvent("downloadFailed", data);
                    } else {
                        DownloadNotificationPlugin.emitEvent("downloadProgress", data);
                    }
                }

                @Override
                public void onDownloadRemoved(DownloadManager manager, Download download) {
                    JSObject data = new JSObject();
                    data.put("id", download.request.id);
                    data.put("state", "removed");
                    data.put("progress", 0);
                    DownloadNotificationPlugin.emitEvent("downloadRemoved", data);
                }
            });
        }
        return downloadManager;
    }

    public static synchronized DownloadNotificationHelper getNotificationHelper(Context ctx) {
        if (notificationHelper == null) {
            ensureChannel(ctx);
            notificationHelper = new DownloadNotificationHelper(ctx, DOWNLOAD_CHANNEL_ID);
        }
        return notificationHelper;
    }

    /** Build DataSource.Factory with auth header for segment fetches. */
    public static DataSource.Factory buildHttpDataSourceFactory() {
        DefaultHttpDataSource.Factory factory = new DefaultHttpDataSource.Factory()
            .setConnectTimeoutMs(15_000)
            .setReadTimeoutMs(120_000)  // long timeout for server-side waitForFile
            .setAllowCrossProtocolRedirects(true);
        if (authToken != null && !authToken.isEmpty()) {
            factory.setDefaultRequestProperties(
                Collections.singletonMap("Authorization", "Bearer " + authToken)
            );
        }
        return factory;
    }

    /** DataSource.Factory for offline playback — reads from cache, falls back to HTTP. */
    public static CacheDataSource.Factory getCacheDataSourceFactory(Context ctx) {
        return new CacheDataSource.Factory()
            .setCache(getCache(ctx))
            .setUpstreamDataSourceFactory(buildHttpDataSourceFactory())
            .setCacheWriteDataSinkFactory(null);  // read-only from cache
    }

    /** Start downloading an HLS stream. */
    public static void startDownload(Context ctx, String id, String hlsUrl) {
        DownloadRequest request = new DownloadRequest.Builder(id, android.net.Uri.parse(hlsUrl))
            .setMimeType(MimeTypes.APPLICATION_M3U8)
            .build();
        DownloadService.sendAddDownload(
            ctx, FlixDownloadService.class, request, /* foreground= */ true
        );
        Log.d(TAG, "Download started: id=" + id + " url=" + hlsUrl);
    }

    /** Remove a download (cancel + delete cached data). */
    public static void removeDownload(Context ctx, String id) {
        DownloadService.sendRemoveDownload(ctx, FlixDownloadService.class, id, /* foreground= */ true);
    }

    /** Pause all downloads. */
    public static void pauseDownloads(Context ctx) {
        DownloadService.sendPauseDownloads(ctx, FlixDownloadService.class, /* foreground= */ false);
    }

    /** Resume all downloads. */
    public static void resumeDownloads(Context ctx) {
        DownloadService.sendResumeDownloads(ctx, FlixDownloadService.class, /* foreground= */ false);
    }

    private static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                DOWNLOAD_CHANNEL_ID,
                "Téléchargements",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Téléchargement de médias pour lecture hors-ligne");
            channel.enableLights(false);
            channel.enableVibration(false);
            NotificationManager nm = ctx.getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(channel);
        }
    }
}
