package media.fliks.app;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.offline.Download;
import androidx.media3.exoplayer.offline.DownloadCursor;
import androidx.media3.exoplayer.offline.DownloadManager;

import java.util.LinkedHashMap;
import java.util.Map;

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
        // Initialize DownloadManager early so its event listener is registered
        // before any download starts (listener lives in FlixDownloadUtil).
        FlixDownloadUtil.getDownloadManager(getContext());
    }

    /** Emit event to WebView JS (called from FlixDownloadUtil listener) */
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

    /** Remove a download (cancel + delete cached data). Waits for removal to complete. */
    @PluginMethod()
    public void removeDownload(PluginCall call) {
        String id = call.getString("id", "");
        DownloadManager dm = FlixDownloadUtil.getDownloadManager(getContext());
        dm.addListener(new DownloadManager.Listener() {
            @Override
            public void onDownloadRemoved(DownloadManager manager, Download download) {
                if (download.request.id.equals(id)) {
                    dm.removeListener(this);
                    call.resolve();
                }
            }
        });
        FlixDownloadUtil.removeDownload(getContext(), id);
        // Timeout fallback — resolve after 3s if event never fires
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            if (!call.isReleased()) call.resolve();
        }, 3000);
    }

    /** Cap concurrent transfers, from the device setting. */
    @PluginMethod()
    public void setMaxConcurrentDownloads(PluginCall call) {
        FlixDownloadUtil.setMaxParallelDownloads(call.getInt("max", 3));
        call.resolve();
    }

    /**
     * Every download the daemon knows about, in flight or finished.
     *
     * Built from the persistent index rather than {@code getCurrentDownloads()}:
     * the DownloadManager loads that table asynchronously after construction, so
     * a call landing before it finishes — which is exactly what happens on app
     * start, when the WebView reconciles — sees an empty list and reports live
     * transfers as gone. Live objects are layered on top for fresher progress.
     */
    @PluginMethod()
    public void getDownloads(PluginCall call) {
        try {
            Map<String, Download> byId = new LinkedHashMap<>();
            try (DownloadCursor cursor =
                     FlixDownloadUtil.getDownloadIndex(getContext()).getDownloads()) {
                while (cursor.moveToNext()) {
                    Download dl = cursor.getDownload();
                    byId.put(dl.request.id, dl);
                }
            }
            DownloadManager dm = FlixDownloadUtil.getDownloadManager(getContext());
            if (dm.isInitialized()) {
                for (Download dl : dm.getCurrentDownloads()) {
                    byId.put(dl.request.id, dl);
                }
            }

            JSArray arr = new JSArray();
            for (Download dl : byId.values()) {
                JSObject obj = new JSObject();
                obj.put("id", dl.request.id);
                obj.put("progress", Math.round(dl.getPercentDownloaded()));
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
            // The index, not the manager: a synchronous DB read that works even
            // before the DownloadManager finishes loading.
            Download dl = FlixDownloadUtil.getDownloadIndex(getContext()).getDownload(id);
            boolean found = dl != null && dl.state == Download.STATE_COMPLETED;
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
