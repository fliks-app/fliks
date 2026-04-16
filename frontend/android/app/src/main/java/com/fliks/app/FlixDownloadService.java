package com.fliks.app;

import android.app.Notification;

import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.offline.Download;
import androidx.media3.exoplayer.offline.DownloadManager;
import androidx.media3.exoplayer.offline.DownloadNotificationHelper;
import androidx.media3.exoplayer.offline.DownloadService;
import androidx.media3.exoplayer.scheduler.Scheduler;

import com.getcapacitor.JSObject;

import java.util.List;

/**
 * ExoPlayer {@link DownloadService} for offline HLS downloads.
 * Runs as a foreground service with progress notifications.
 *
 * Progress events are emitted to WebView from {@link #getForegroundNotification},
 * which Android calls ~1/s while downloads are active. State-change events
 * (completed, failed, removed) are emitted by the listener in {@link FlixDownloadUtil}.
 */
@OptIn(markerClass = UnstableApi.class)
public class FlixDownloadService extends DownloadService {

    public FlixDownloadService() {
        super(FlixDownloadUtil.FOREGROUND_NOTIFICATION_ID);
    }

    @Override
    protected DownloadManager getDownloadManager() {
        return FlixDownloadUtil.getDownloadManager(this);
    }

    @Override
    @Nullable
    protected Scheduler getScheduler() {
        return null;
    }

    @Override
    protected Notification getForegroundNotification(
        List<Download> downloads, int notMetRequirements
    ) {
        // Emit progress events — this method is called ~1/s by the framework
        // during active downloads. onDownloadChanged only fires on state
        // transitions, not progress updates.
        for (Download dl : downloads) {
            if (dl.state == Download.STATE_DOWNLOADING) {
                JSObject data = new JSObject();
                data.put("id", dl.request.id);
                data.put("progress", Math.round(dl.getPercentDownloaded()));
                data.put("state", "downloading");
                DownloadNotificationPlugin.emitEvent("downloadProgress", data);
            }
        }

        DownloadNotificationHelper helper =
            FlixDownloadUtil.getNotificationHelper(this);
        return helper.buildProgressNotification(
            this,
            android.R.drawable.stat_sys_download,
            /* contentIntent= */ null,
            /* message= */ null,
            downloads,
            notMetRequirements
        );
    }
}
