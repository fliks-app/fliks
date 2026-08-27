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
import androidx.media3.database.DatabaseProvider;
import androidx.media3.exoplayer.offline.DefaultDownloadIndex;
import androidx.media3.exoplayer.offline.Download;
import androidx.media3.exoplayer.offline.DownloadManager;
import androidx.media3.exoplayer.offline.DownloadNotificationHelper;
import androidx.media3.exoplayer.offline.DownloadRequest;
import androidx.media3.exoplayer.offline.DownloadService;

import java.io.File;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

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

    /** Worker pool size. Sized to the largest cap the settings screen offers so
     *  raising the cap isn't bottlenecked by a pool fixed at construction;
     *  {@link DownloadManager#setMaxParallelDownloads} is what actually gates
     *  concurrency, and it can be changed on a live manager. */
    private static final int MAX_SUPPORTED_PARALLEL = 5;
    /** Concurrent transfers, in force until the WebView pushes the user's
     *  setting. Held statically so it survives the manager being built later. */
    private static int maxParallelDownloads = 3;

    private static SimpleCache cache;
    private static DatabaseProvider databaseProvider;
    private static DefaultDownloadIndex downloadIndex;
    private static DownloadManager downloadManager;
    private static DownloadNotificationHelper notificationHelper;
    private static String authToken;

    public static synchronized void setAuthToken(String token) {
        authToken = token;
    }

    /** Cap concurrent transfers. Applies to a manager that already exists, and
     *  is remembered for one built later. */
    public static synchronized void setMaxParallelDownloads(int value) {
        maxParallelDownloads = Math.max(1, Math.min(MAX_SUPPORTED_PARALLEL, value));
        if (downloadManager != null) {
            downloadManager.setMaxParallelDownloads(maxParallelDownloads);
        }
    }

    /** One SQLite helper for the whole app. The cache, the manager and the
     *  index all sit on the same database file; handing each its own helper is
     *  how you end up with locking surprises. */
    public static synchronized DatabaseProvider getDatabaseProvider(Context ctx) {
        if (databaseProvider == null) {
            databaseProvider = new StandaloneDatabaseProvider(ctx.getApplicationContext());
        }
        return databaseProvider;
    }

    /** The persistent download table. Readable straight away, unlike the
     *  DownloadManager, which loads it asynchronously after construction. */
    /**
     * Worker pool for the DownloadManager.
     *
     * A plain fixed pool never reclaims its core threads, so one burst at the
     * highest cap leaves that many parked for the life of the process. Letting
     * them time out keeps the ceiling — an unbounded cached pool would trade a
     * known cost for an open-ended one — while giving the threads back once the
     * downloads are done.
     */
    private static ThreadPoolExecutor buildDownloadExecutor() {
        ThreadPoolExecutor executor =
            (ThreadPoolExecutor) Executors.newFixedThreadPool(MAX_SUPPORTED_PARALLEL);
        // Must precede allowCoreThreadTimeOut: newFixedThreadPool leaves the
        // keep-alive at zero, and enabling the timeout on zero throws.
        executor.setKeepAliveTime(60, TimeUnit.SECONDS);
        executor.allowCoreThreadTimeOut(true);
        return executor;
    }

    public static synchronized DefaultDownloadIndex getDownloadIndex(Context ctx) {
        if (downloadIndex == null) {
            downloadIndex = new DefaultDownloadIndex(getDatabaseProvider(ctx));
        }
        return downloadIndex;
    }

    public static synchronized SimpleCache getCache(Context ctx) {
        if (cache == null) {
            File cacheDir = new File(ctx.getFilesDir(), "fliks-offline");
            cache = new SimpleCache(
                cacheDir,
                new NoOpCacheEvictor(),
                getDatabaseProvider(ctx)
            );
        }
        return cache;
    }

    public static synchronized DownloadManager getDownloadManager(Context ctx) {
        if (downloadManager == null) {
            ensureChannel(ctx);
            downloadManager = new DownloadManager(
                ctx,
                getDatabaseProvider(ctx),
                getCache(ctx),
                buildHttpDataSourceFactory(),
                buildDownloadExecutor()
            );
            downloadManager.setMaxParallelDownloads(maxParallelDownloads);
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
