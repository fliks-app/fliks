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
 * All download logic is handled by Media3's {@link DownloadManager} —
 * this class only provides the notification UI and event bridge to WebView.
 */
@OptIn(markerClass = UnstableApi.class)
public class FlixDownloadService extends DownloadService {

    public FlixDownloadService() {
        super(FlixDownloadUtil.FOREGROUND_NOTIFICATION_ID);
    }

    @Override
    protected DownloadManager getDownloadManager() {
        DownloadManager dm = FlixDownloadUtil.getDownloadManager(this);
        // Listen for state changes → emit events to WebView
        dm.addListener(new DownloadManager.Listener() {
            @Override
            public void onDownloadChanged(DownloadManager manager, Download download, @Nullable Exception finalException) {
                emitDownloadEvent(download);
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
        return dm;
    }

    @Override
    @Nullable
    protected Scheduler getScheduler() {
        // No conditional scheduling — downloads run immediately
        return null;
    }

    @Override
    protected Notification getForegroundNotification(
        List<Download> downloads, int notMetRequirements
    ) {
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

    private void emitDownloadEvent(Download download) {
        JSObject data = new JSObject();
        data.put("id", download.request.id);
        data.put("progress", download.getPercentDownloaded());

        String state;
        switch (download.state) {
            case Download.STATE_QUEUED:
                state = "queued";
                break;
            case Download.STATE_DOWNLOADING:
                state = "downloading";
                break;
            case Download.STATE_COMPLETED:
                state = "completed";
                break;
            case Download.STATE_FAILED:
                state = "failed";
                break;
            case Download.STATE_REMOVING:
                state = "removing";
                break;
            case Download.STATE_STOPPED:
                state = "stopped";
                break;
            default:
                state = "unknown";
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
}
