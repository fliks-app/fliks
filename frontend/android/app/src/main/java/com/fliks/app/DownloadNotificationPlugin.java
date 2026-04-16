package com.fliks.app;

import android.util.Log;

import androidx.annotation.OptIn;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.offline.Download;
import androidx.media3.exoplayer.offline.DownloadManager;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Capacitor plugin bridging ExoPlayer's DownloadManager ↔ WebView.
 * All download logic is handled by Media3 — this plugin just provides
 * the JS interface and emits progress events.
 */
@CapacitorPlugin(name = "DownloadNotification")
@OptIn(markerClass = UnstableApi.class)
public class DownloadNotificationPlugin extends Plugin {

    private static final String TAG = "DownloadNotification";
    private static DownloadNotificationPlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    /** Emit event to WebView JS (called from FlixDownloadService) */
    public static void emitEvent(String eventName, JSObject data) {
        if (instance != null) {
            instance.notifyListeners(eventName, data);
        }
    }

    /** Start an HLS download via ExoPlayer DownloadManager. */
    @PluginMethod()
    public void startDownload(PluginCall call) {
        String id = call.getString("id", "");
        String hlsUrl = call.getString("hlsUrl", "");
        String token = call.getString("token", "");

        if (id.isEmpty() || hlsUrl.isEmpty()) {
            call.reject("id and hlsUrl are required");
            return;
        }

        FlixDownloadUtil.setAuthToken(token);
        FlixDownloadUtil.startDownload(getContext(), id, hlsUrl);
        call.resolve();
    }

    /** Remove a download (cancel + delete cached data). */
    @PluginMethod()
    public void removeDownload(PluginCall call) {
        String id = call.getString("id", "");
        FlixDownloadUtil.removeDownload(getContext(), id);
        call.resolve();
    }

    /** Get all downloads with their current state + progress. */
    @PluginMethod()
    public void getDownloads(PluginCall call) {
        try {
            DownloadManager dm = FlixDownloadUtil.getDownloadManager(getContext());
            JSArray arr = new JSArray();
            for (Download dl : dm.getCurrentDownloads()) {
                JSObject obj = new JSObject();
                obj.put("id", dl.request.id);
                obj.put("progress", dl.getPercentDownloaded());
                obj.put("state", stateToString(dl.state));
                obj.put("bytesDownloaded", dl.getBytesDownloaded());
                arr.put(obj);
            }
            JSObject result = new JSObject();
            result.put("downloads", arr.toString());
            call.resolve(result);
        } catch (Exception e) {
            Log.w(TAG, "getDownloads failed: " + e.getMessage());
            JSObject result = new JSObject();
            result.put("downloads", "[]");
            call.resolve(result);
        }
    }

    /** Check if a download exists and is completed. */
    @PluginMethod()
    public void isDownloaded(PluginCall call) {
        try {
            String id = call.getString("id", "");
            DownloadManager dm = FlixDownloadUtil.getDownloadManager(getContext());
            boolean found = false;
            for (Download dl : dm.getCurrentDownloads()) {
                if (dl.request.id.equals(id) && dl.state == Download.STATE_COMPLETED) {
                    found = true;
                    break;
                }
            }
            JSObject result = new JSObject();
            result.put("downloaded", found);
            call.resolve(result);
        } catch (Exception e) {
            JSObject result = new JSObject();
            result.put("downloaded", false);
            call.resolve(result);
        }
    }

    private static String stateToString(int state) {
        switch (state) {
            case Download.STATE_QUEUED: return "queued";
            case Download.STATE_DOWNLOADING: return "downloading";
            case Download.STATE_COMPLETED: return "completed";
            case Download.STATE_FAILED: return "failed";
            case Download.STATE_REMOVING: return "removing";
            case Download.STATE_STOPPED: return "stopped";
            default: return "unknown";
        }
    }
}
