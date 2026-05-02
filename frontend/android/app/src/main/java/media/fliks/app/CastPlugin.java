package media.fliks.app;

import android.content.Context;
import android.net.wifi.WifiManager;
import android.util.Log;

import androidx.appcompat.app.AppCompatActivity;
import androidx.mediarouter.app.MediaRouteChooserDialogFragment;
import androidx.mediarouter.media.MediaRouteSelector;
import androidx.mediarouter.media.MediaRouter;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.cast.CastMediaControlIntent;
import com.google.android.gms.cast.MediaInfo;
import com.google.android.gms.cast.MediaLoadRequestData;
import com.google.android.gms.cast.MediaMetadata;
import com.google.android.gms.cast.MediaTrack;
import com.google.android.gms.cast.TextTrackStyle;
import com.google.android.gms.cast.framework.CastContext;
import com.google.android.gms.cast.framework.CastSession;
import com.google.android.gms.cast.framework.SessionManager;
import com.google.android.gms.cast.framework.SessionManagerListener;
import com.google.android.gms.cast.framework.media.RemoteMediaClient;
import com.google.android.gms.common.images.WebImage;

import android.net.Uri;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Capacitor plugin for Google Cast on Android.
 *
 * Usage from JS:
 *   await NativeCast.initialize({ appId: 'CC1AD845' });
 *   await NativeCast.requestSession();
 *   await NativeCast.loadMedia({ url, contentType, title, ... });
 *   await NativeCast.play() / pause() / seek({ time }) / stop();
 */
@CapacitorPlugin(name = "NativeCast")
public class CastPlugin extends Plugin {
    private static final String TAG = "CastPlugin";

    /** Cast APIs require the main (UI) thread; Capacitor invokes plugin methods on a background thread. */
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private void runOnMainThread(Runnable r) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            r.run();
        } else {
            mainHandler.post(r);
        }
    }

    private CastContext castContext;
    private SessionManager sessionManager;
    private CastSession castSession;
    private WifiManager.WifiLock wifiLock;
    /** True between the user picking a device and the session starting/failing. */
    private volatile boolean sessionPending = false;

    /**
     * Cast session updates must stay on the main thread (same as Session / isConnected rules).
     * Some Play Services versions invoke these callbacks off the UI thread.
     */
    private final SessionManagerListener<CastSession> sessionListener = new SessionManagerListener<CastSession>() {
        @Override
        public void onSessionStarted(CastSession session, String sessionId) {
            runOnMainThread(() -> {
                sessionPending = false;
                castSession = session;
                acquireWifiLock();
                notifyJS("connected", true);
            });
        }
        @Override
        public void onSessionEnded(CastSession session, int error) {
            runOnMainThread(() -> {
                sessionPending = false;
                castSession = null;
                releaseWifiLock();
                notifyJS("connected", false);
            });
        }
        @Override
        public void onSessionResumed(CastSession session, boolean wasSuspended) {
            runOnMainThread(() -> {
                sessionPending = false;
                castSession = session;
                acquireWifiLock();
                notifyJS("connected", true);
            });
        }
        @Override
        public void onSessionSuspended(CastSession session, int reason) {
            releaseWifiLock();
        }
        @Override
        public void onSessionStarting(CastSession session) {
            // Must set immediately on the callback thread (volatile). If we only post to the main
            // looper, MediaRouteChooserDialogFragment can be destroyed on the main thread before
            // that runnable runs, and we wrongly fire castPickerDismissed (JS thinks user cancelled).
            sessionPending = true;
        }
        @Override
        public void onSessionStartFailed(CastSession session, int error) {
            runOnMainThread(() -> {
                sessionPending = false;
                notifyJS("connected", false);
                notifyPickerDismissed(); // also reset connecting spinner
            });
        }
        @Override
        public void onSessionEnding(CastSession session) {}
        @Override
        public void onSessionResuming(CastSession session, String sessionId) {
            sessionPending = true;
        }
        @Override
        public void onSessionResumeFailed(CastSession session, int error) {
            runOnMainThread(() -> {
                sessionPending = false;
                notifyJS("connected", false);
                notifyPickerDismissed();
            });
        }
    };

    private void acquireWifiLock() {
        if (wifiLock == null) {
            WifiManager wm = (WifiManager) getContext().getApplicationContext()
                    .getSystemService(Context.WIFI_SERVICE);
            wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "fliks:cast");
        }
        if (!wifiLock.isHeld()) wifiLock.acquire();
    }

    private void releaseWifiLock() {
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
    }

    private void notifyJS(String key, boolean value) {
        String js = "window.dispatchEvent(new CustomEvent('castStateChanged', { detail: { " + key + ": " + value + " } }));";
        getBridge().getWebView().post(() ->
            getBridge().getWebView().evaluateJavascript(js, null)
        );
    }

    private void notifyPickerDismissed() {
        String js = "window.dispatchEvent(new CustomEvent('castPickerDismissed'));";
        getBridge().getWebView().post(() ->
            getBridge().getWebView().evaluateJavascript(js, null)
        );
    }

    private void notifyJSTime(double time, double duration, boolean paused) {
        String js = "window.dispatchEvent(new CustomEvent('castMediaUpdate', { detail: { "
            + "currentTime: " + time + ", duration: " + duration + ", isPaused: " + paused + " } }));";
        getBridge().getWebView().post(() ->
            getBridge().getWebView().evaluateJavascript(js, null)
        );
    }

    @PluginMethod()
    public void initialize(PluginCall call) {
        runOnMainThread(() -> {
            try {
                castContext = CastContext.getSharedInstance(getContext());
                sessionManager = castContext.getSessionManager();
                sessionManager.addSessionManagerListener(sessionListener, CastSession.class);

                // Check if already connected
                castSession = sessionManager.getCurrentCastSession();
                call.resolve(new JSObject().put("available", true));
            } catch (Exception e) {
                Log.e(TAG, "Cast init failed", e);
                call.resolve(new JSObject().put("available", false));
            }
        });
    }

    @PluginMethod()
    public void isAvailable(PluginCall call) {
        boolean available = castContext != null;
        call.resolve(new JSObject().put("available", available));
    }

    @PluginMethod()
    public void isConnected(PluginCall call) {
        runOnMainThread(() -> {
            boolean connected = castSession != null && castSession.isConnected();
            call.resolve(new JSObject().put("connected", connected));
        });
    }

    @PluginMethod()
    public void requestSession(PluginCall call) {
        runOnMainThread(() -> {
            try {
                MediaRouteSelector selector = new MediaRouteSelector.Builder()
                    .addControlCategory(CastMediaControlIntent.categoryForCast(
                        CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID))
                    .build();

                MediaRouteChooserDialogFragment dialog = new MediaRouteChooserDialogFragment();
                dialog.setRouteSelector(selector);

                // Notify JS when the dialog is dismissed without connecting
                ((AppCompatActivity) getActivity()).getSupportFragmentManager()
                    .registerFragmentLifecycleCallbacks(new androidx.fragment.app.FragmentManager.FragmentLifecycleCallbacks() {
                        @Override
                        public void onFragmentDestroyed(androidx.fragment.app.FragmentManager fm, androidx.fragment.app.Fragment f) {
                            if (f == dialog) {
                                fm.unregisterFragmentLifecycleCallbacks(this);
                                // Defer so any SessionManager callbacks already posted to the main queue
                                // run first (ordering with sessionPending / castSession updates).
                                mainHandler.post(() -> {
                                    if (!sessionPending && (castSession == null || !castSession.isConnected())) {
                                        notifyPickerDismissed();
                                    }
                                });
                            }
                        }
                    }, false);

                dialog.show(((AppCompatActivity) getActivity()).getSupportFragmentManager(), "cast_picker");
                call.resolve();
            } catch (Exception e) {
                Log.e(TAG, "Failed to show Cast picker", e);
                call.reject("Failed to show Cast picker", e);
            }
        });
    }

    @PluginMethod()
    public void loadMedia(PluginCall call) {
        runOnMainThread(() -> doLoadMedia(call));
    }

    private void doLoadMedia(PluginCall call) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            runOnMainThread(() -> doLoadMedia(call));
            return;
        }
        if (castSession == null || !castSession.isConnected()) {
            call.reject("Not connected to Cast device");
            return;
        }

        String url = call.getString("url");
        String contentType = call.getString("contentType", "application/x-mpegurl");
        String title = call.getString("title", "");
        String subtitle = call.getString("subtitle", "");
        String posterUrl = call.getString("posterUrl", "");
        double currentTime = call.getDouble("currentTime", 0.0);
        Integer activeTrackId = call.getInt("activeSubtitleTrackId");

        MediaMetadata metadata = new MediaMetadata(MediaMetadata.MEDIA_TYPE_MOVIE);
        metadata.putString(MediaMetadata.KEY_TITLE, title);
        metadata.putString(MediaMetadata.KEY_SUBTITLE, subtitle);
        if (posterUrl != null && !posterUrl.isEmpty()) {
            metadata.addImage(new WebImage(Uri.parse(posterUrl)));
        }

        MediaInfo.Builder mediaInfoBuilder = new MediaInfo.Builder(url)
            .setStreamType(MediaInfo.STREAM_TYPE_BUFFERED)
            .setContentType(contentType)
            .setMetadata(metadata);

        // customData is the side-channel the Fliks Cast Receiver reads to
        // identify the media (mediaId / episodeId) without parsing the URL.
        // The Default Media Receiver ignores it harmlessly when used as a
        // fallback receiver. Capacitor's JSObject IS-A JSONObject so it
        // can be forwarded directly without re-parsing.
        JSObject customData = call.getObject("customData");
        if (customData != null) {
            mediaInfoBuilder.setCustomData(customData);
        }

        // Subtitles
        JSArray subtitlesArray = call.getArray("subtitles");
        List<MediaTrack> tracks = new ArrayList<>();
        if (subtitlesArray != null) {
            try {
                for (int i = 0; i < subtitlesArray.length(); i++) {
                    JSONObject sub = subtitlesArray.getJSONObject(i);
                    MediaTrack track = new MediaTrack.Builder(i + 1, MediaTrack.TYPE_TEXT)
                        .setContentId(sub.getString("url"))
                        .setContentType("text/vtt")
                        .setSubtype(MediaTrack.SUBTYPE_SUBTITLES)
                        .setName(sub.optString("label", ""))
                        .setLanguage(sub.optString("language", "und"))
                        .build();
                    tracks.add(track);
                }
            } catch (Exception e) {
                Log.w(TAG, "Error parsing subtitles", e);
            }
        }
        if (!tracks.isEmpty()) {
            mediaInfoBuilder.setMediaTracks(tracks);

            TextTrackStyle trackStyle = new TextTrackStyle();
            trackStyle.setFontScale(0.85f);
            trackStyle.setFontGenericFamily(TextTrackStyle.FONT_FAMILY_SANS_SERIF);
            trackStyle.setForegroundColor(0xFFFFFFFF);
            trackStyle.setBackgroundColor(0x00000000);
            trackStyle.setWindowColor(0x00000000);

            trackStyle.setWindowType(TextTrackStyle.WINDOW_TYPE_NONE);
            trackStyle.setEdgeType(TextTrackStyle.EDGE_TYPE_DROP_SHADOW);
            trackStyle.setEdgeColor(0xFF000000);
            mediaInfoBuilder.setTextTrackStyle(trackStyle);
        }

        MediaInfo mediaInfo = mediaInfoBuilder.build();

        MediaLoadRequestData.Builder requestBuilder = new MediaLoadRequestData.Builder()
            .setMediaInfo(mediaInfo)
            .setAutoplay(true)
            .setCurrentTime((long) (currentTime * 1000));

        if (activeTrackId != null && activeTrackId > 0) {
            long[] activeIds = new long[] { activeTrackId };
            requestBuilder.setActiveTrackIds(activeIds);
        }

        RemoteMediaClient client = castSession.getRemoteMediaClient();
        if (client == null) {
            call.reject("No remote media client");
            return;
        }

        client.load(requestBuilder.build());

        // Apply text track style after load (Default Media Receiver ignores it in MediaInfo)
        if (!tracks.isEmpty()) {
            pollHandler = mainHandler;
            pollHandler.postDelayed(() -> {
                try {
                    TextTrackStyle style = new TextTrackStyle();
                    style.setFontScale(0.85f);
                    style.setFontGenericFamily(TextTrackStyle.FONT_FAMILY_SANS_SERIF);
                    style.setForegroundColor(0xFFFFFFFF);
                    style.setBackgroundColor(0x00000000);
                    style.setWindowColor(0x00000000);
                    style.setWindowType(TextTrackStyle.WINDOW_TYPE_NONE);
                    style.setEdgeType(TextTrackStyle.EDGE_TYPE_DROP_SHADOW);
                    style.setEdgeColor(0xFF000000);
                    client.setTextTrackStyle(style);
                } catch (Exception e) {
                    Log.w(TAG, "Failed to set track style", e);
                }
            }, 2000);
        }

        // Start position/state polling
        startMediaPolling(client);

        call.resolve();
    }

    @PluginMethod()
    public void play(PluginCall call) {
        runOnMainThread(() -> {
            RemoteMediaClient client = getClient();
            if (client != null) client.play();
            call.resolve();
        });
    }

    @PluginMethod()
    public void pause(PluginCall call) {
        runOnMainThread(() -> {
            RemoteMediaClient client = getClient();
            if (client != null) client.pause();
            call.resolve();
        });
    }

    @PluginMethod()
    public void seek(PluginCall call) {
        runOnMainThread(() -> {
            RemoteMediaClient client = getClient();
            if (client != null) {
                double time = call.getDouble("time", 0.0);
                client.seek(new com.google.android.gms.cast.MediaSeekOptions.Builder()
                    .setPosition((long) (time * 1000))
                    .build());
            }
            call.resolve();
        });
    }

    @PluginMethod()
    public void stop(PluginCall call) {
        runOnMainThread(() -> {
            RemoteMediaClient client = getClient();
            if (client != null) client.stop();
            call.resolve();
        });
    }

    @PluginMethod()
    public void disconnect(PluginCall call) {
        runOnMainThread(() -> {
            if (sessionManager != null) {
                sessionManager.endCurrentSession(true);
            }
            castSession = null;
            call.resolve();
        });
    }

    @PluginMethod()
    public void setActiveSubtitle(PluginCall call) {
        runOnMainThread(() -> {
            RemoteMediaClient client = getClient();
            if (client != null) {
                int trackId = call.getInt("trackId", 0);
                if (trackId > 0) {
                    client.setActiveMediaTracks(new long[] { trackId });
                } else {
                    client.setActiveMediaTracks(new long[] {});
                }
            }
            call.resolve();
        });
    }

    private RemoteMediaClient getClient() {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            Log.w(TAG, "getClient() must run on main thread");
            return null;
        }
        if (castSession == null || !castSession.isConnected()) return null;
        return castSession.getRemoteMediaClient();
    }

    private Handler pollHandler;
    private Runnable pollRunnable;

    private void startMediaPolling(RemoteMediaClient client) {
        stopMediaPolling();
        pollHandler = mainHandler;
        pollRunnable = new Runnable() {
            @Override
            public void run() {
                if (Looper.myLooper() != Looper.getMainLooper()) {
                    mainHandler.post(this);
                    return;
                }
                try {
                    if (castSession == null || !castSession.isConnected()) return;
                    double time = client.getApproximateStreamPosition() / 1000.0;
                    double duration = client.getStreamDuration() / 1000.0;
                    boolean paused = client.isPaused();
                    notifyJSTime(time, duration, paused);
                    pollHandler.postDelayed(this, 1000);
                } catch (Exception e) {
                    Log.w(TAG, "Polling error", e);
                }
            }
        };
        pollHandler.postDelayed(pollRunnable, 1000);
    }

    private void stopMediaPolling() {
        if (pollHandler != null && pollRunnable != null) {
            pollHandler.removeCallbacks(pollRunnable);
        }
    }
}
