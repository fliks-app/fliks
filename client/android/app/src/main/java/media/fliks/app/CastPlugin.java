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
import com.google.android.gms.cast.MediaStatus;
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

    /** Passive route discovery: the picker's own list doesn't warrant an active scan on top. */
    private final MediaRouter.Callback routeCallback = new MediaRouter.Callback() {
        @Override
        public void onRouteAdded(MediaRouter router, MediaRouter.RouteInfo route) {
            notifyCastDevicesChanged();
        }
        @Override
        public void onRouteChanged(MediaRouter router, MediaRouter.RouteInfo route) {
            notifyCastDevicesChanged();
        }
        @Override
        public void onRouteRemoved(MediaRouter router, MediaRouter.RouteInfo route) {
            notifyCastDevicesChanged();
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

    private void notifyCastDevicesChanged() {
        String js = "window.dispatchEvent(new CustomEvent('castDevicesChanged'));";
        getBridge().getWebView().post(() ->
            getBridge().getWebView().evaluateJavascript(js, null)
        );
    }

    private void notifyJSTime(double time, double duration, boolean paused, boolean buffering,
                             double volume, boolean muted) {
        String js = "window.dispatchEvent(new CustomEvent('castMediaUpdate', { detail: { "
            + "currentTime: " + time + ", duration: " + duration + ", isPaused: " + paused
            + ", buffering: " + buffering + ", volume: " + volume + ", muted: " + muted
            + " } }));";
        getBridge().getWebView().post(() ->
            getBridge().getWebView().evaluateJavascript(js, null)
        );
    }

    /** Tell the sender the receiver hit a fatal error so it can re-establish
     *  a fresh stream session and resume at {@code position} seconds. */
    private void notifyCastError(double position) {
        String js = "window.dispatchEvent(new CustomEvent('castError', { detail: { position: "
            + position + " } }));";
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
                MediaRouter.getInstance(getContext()).addCallback(buildCastSelector(), routeCallback);

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

    /** Shared by requestSession (native dialog) and getCastDevices/selectCastDevice (custom list). */
    private MediaRouteSelector buildCastSelector() {
        return new MediaRouteSelector.Builder()
            .addControlCategory(CastMediaControlIntent.categoryForCast(
                CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID))
            .build();
    }

    @PluginMethod()
    public void requestSession(PluginCall call) {
        runOnMainThread(() -> {
            try {
                MediaRouteSelector selector = buildCastSelector();

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

    /** Lets the web layer render its own device list instead of the native chooser dialog. */
    @PluginMethod()
    public void getCastDevices(PluginCall call) {
        runOnMainThread(() -> {
            MediaRouteSelector selector = buildCastSelector();
            MediaRouter router = MediaRouter.getInstance(getContext());
            JSArray devices = new JSArray();
            for (MediaRouter.RouteInfo route : router.getRoutes()) {
                if (route.isDefaultOrBluetooth() || !route.matchesSelector(selector)) continue;
                JSObject device = new JSObject();
                device.put("id", route.getId());
                device.put("name", route.getName());
                String modelName = route.getDescription();
                if (modelName != null) device.put("modelName", modelName);
                devices.put(device);
            }
            call.resolve(new JSObject().put("devices", devices));
        });
    }

    @PluginMethod()
    public void selectCastDevice(PluginCall call) {
        runOnMainThread(() -> {
            String id = call.getString("id");
            MediaRouter router = MediaRouter.getInstance(getContext());
            MediaRouter.RouteInfo target = null;
            for (MediaRouter.RouteInfo route : router.getRoutes()) {
                if (route.getId().equals(id)) {
                    target = route;
                    break;
                }
            }
            if (target == null) {
                Log.w(TAG, "selectCastDevice: no route matches id " + id);
                call.reject("No matching Cast device");
                return;
            }
            // Result surfaces via the existing SessionManagerListener (onSessionStarted / onSessionStartFailed).
            router.selectRoute(target);
            call.resolve();
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
        JSObject styleSpec = call.getObject("textTrackStyle");
        if (!tracks.isEmpty()) {
            mediaInfoBuilder.setMediaTracks(tracks);
        }
        // Always set the style — receiver fills its defaults when
        // textTrackStyle is missing, masking the user's prefs whenever
        // the LOAD has no preselected subtitle tracks.
        mediaInfoBuilder.setTextTrackStyle(buildTextTrackStyle(styleSpec));

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
        pollHandler = mainHandler;
        pollHandler.postDelayed(() -> {
            try {
                client.setTextTrackStyle(buildTextTrackStyle(styleSpec));
            } catch (Exception e) {
                Log.w(TAG, "Failed to set track style", e);
            }
        }, 2000);

        // Re-arm error detection for this stream and seed the resume anchor
        // with the load offset (polling overwrites it once playback ticks).
        errorReported = false;
        lastGoodPosition = currentTime;

        // Start position/state polling
        startMediaPolling(client);

        call.resolve();
    }

    /**
     * Map the sender's subtitle presets ({@code size} / {@code color} /
     * {@code shadow} / {@code background}) onto Cast SDK's
     * {@link TextTrackStyle}. Same preset vocabulary as the local
     * player settings — keeps a single shared UI between both. When
     * {@code spec} is null, returns the receiver-matching defaults.
     */
    private TextTrackStyle buildTextTrackStyle(JSObject spec) {
        TextTrackStyle style = new TextTrackStyle();
        style.setFontGenericFamily(TextTrackStyle.FONT_FAMILY_SANS_SERIF);
        style.setWindowType(TextTrackStyle.WINDOW_TYPE_NONE);
        style.setWindowColor(0x00000000);
        String size = spec != null ? spec.optString("size", "normal") : "normal";
        String color = spec != null ? spec.optString("color", "white") : "white";
        String shadow = spec != null ? spec.optString("shadow", "drop") : "drop";
        String bg = spec != null ? spec.optString("background", "transparent") : "transparent";
        style.setFontScale(mapSize(size));
        style.setForegroundColor(mapFgColor(color));
        style.setBackgroundColor(mapBgColor(bg));
        int[] edge = mapShadow(shadow);
        style.setEdgeType(edge[0]);
        style.setEdgeColor(edge[1]);
        return style;
    }

    private static float mapSize(String name) {
        switch (name) {
            case "small": return 0.7f;
            case "large": return 1.1f;
            case "xlarge": return 1.4f;
            default: return 0.85f;
        }
    }

    private static int mapFgColor(String name) {
        switch (name) {
            case "yellow": return 0xFFFFFF00;
            case "green": return 0xFF00FF00;
            case "cyan": return 0xFF00FFFF;
            default: return 0xFFFFFFFF;
        }
    }

    private static int mapBgColor(String name) {
        switch (name) {
            case "semi": return 0x80000000;
            case "black": return 0xFF000000;
            // Cast SDK on Android strips integer-color fields equal to
            // 0 from the wire payload (treats them as "unset"), so the
            // receiver falls through to CAF's built-in default — which
            // happens to render an opaque black box. Use a non-zero
            // value with alpha 0: still fully transparent visually,
            // but serialised on the wire as #01000000 so the receiver
            // sees an explicit transparent backgroundColor.
            default: return 0x00010000;
        }
    }

    /** Returns {edgeType, edgeColor}. */
    private static int[] mapShadow(String name) {
        switch (name) {
            // Same wire-omission concern as transparent backgrounds —
            // a 0 colour is stripped, the receiver picks its default.
            // Edge isn't rendered when type=NONE so the visible result
            // is the same; we keep the wire frame complete for
            // determinism / debuggability.
            case "none": return new int[] { TextTrackStyle.EDGE_TYPE_NONE, 0x00010000 };
            case "outline": return new int[] { TextTrackStyle.EDGE_TYPE_OUTLINE, 0xFF000000 };
            case "raised": return new int[] { TextTrackStyle.EDGE_TYPE_RAISED, 0xFF000000 };
            default: return new int[] { TextTrackStyle.EDGE_TYPE_DROP_SHADOW, 0xFF000000 };
        }
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
    public void setVolume(PluginCall call) {
        runOnMainThread(() -> {
            double level = call.getDouble("level", 1.0);
            level = Math.max(0.0, Math.min(1.0, level));
            if (castSession != null && castSession.isConnected()) {
                try {
                    castSession.setVolume(level);
                } catch (Exception e) {
                    Log.w(TAG, "setVolume failed", e);
                }
            }
            call.resolve();
        });
    }

    @PluginMethod()
    public void setMuted(PluginCall call) {
        runOnMainThread(() -> {
            boolean muted = call.getBoolean("muted", false);
            if (castSession != null && castSession.isConnected()) {
                try {
                    castSession.setMute(muted);
                } catch (Exception e) {
                    Log.w(TAG, "setMute failed", e);
                }
            }
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

    /**
     * Switch the active audio rendition on the receiver via the standard
     * media bus (setActiveMediaTracks → EDIT_TRACKS_INFO). The receiver
     * mirrors Shaka's HLS audio renditions into MediaInformation as
     * AUDIO tracks, so Cast SDK's track-selection API drives the swap
     * client-side without an ffmpeg restart.
     *
     * Resolves with {@code success: false} when no matching track is
     * found — caller falls back to a full reload in that case.
     */
    @PluginMethod()
    public void setActiveAudioLanguage(PluginCall call) {
        runOnMainThread(() -> {
            String language = call.getString("language", "");
            String name = call.getString("name", "");
            RemoteMediaClient client = getClient();
            if (client == null) {
                call.resolve(new JSObject().put("success", false));
                return;
            }
            // Prefer MediaStatus' MediaInfo: it reflects receiver-side
            // setMediaInformation() updates (where the audio renditions are
            // published). Fall back to client.getMediaInfo() for safety.
            MediaInfo mediaInfo = client.getMediaStatus() != null
                ? client.getMediaStatus().getMediaInfo()
                : null;
            if (mediaInfo == null) mediaInfo = client.getMediaInfo();
            List<MediaTrack> tracks = mediaInfo != null ? mediaInfo.getMediaTracks() : null;
            if (tracks == null || tracks.isEmpty()) {
                call.resolve(new JSObject().put("success", false));
                return;
            }
            // Match by NAME first: Shaka rewrites manifest LANGUAGE from
            // ISO 639-2 (eng) to ISO 639-1 (en) before exposing renditions,
            // so plain language equality fails on 3-letter sources. The
            // NAME emitted in master.m3u8 (track title or language fallback)
            // is preserved verbatim.
            MediaTrack target = null;
            for (MediaTrack t : tracks) {
                if (t.getType() == MediaTrack.TYPE_AUDIO && name.equals(t.getName())) {
                    target = t;
                    break;
                }
            }
            if (target == null) {
                for (MediaTrack t : tracks) {
                    if (t.getType() == MediaTrack.TYPE_AUDIO && language.equals(t.getLanguage())) {
                        target = t;
                        break;
                    }
                }
            }
            if (target == null) {
                call.resolve(new JSObject().put("success", false));
                return;
            }
            // Preserve any active text track — setActiveMediaTracks replaces
            // the whole active set in one shot, mirroring the web's
            // applyActiveTracks union semantics.
            long textId = -1;
            if (client.getMediaStatus() != null) {
                long[] active = client.getMediaStatus().getActiveTrackIds();
                if (active != null) {
                    for (long id : active) {
                        for (MediaTrack t : tracks) {
                            if (t.getId() == id && t.getType() == MediaTrack.TYPE_TEXT) {
                                textId = id;
                                break;
                            }
                        }
                        if (textId >= 0) break;
                    }
                }
            }
            long[] newActive = textId >= 0
                ? new long[] { target.getId(), textId }
                : new long[] { target.getId() };
            client.setActiveMediaTracks(newActive);
            call.resolve(new JSObject().put("success", true));
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
    /** Last playhead (seconds) seen while the receiver was actively playing —
     *  handed to the sender on a fatal error so it resumes at the right spot. */
    private double lastGoodPosition = 0;
    /** Latches IDLE/ERROR so one fatal error fires a single castError, not one
     *  per poll tick. Cleared when the receiver leaves the idle state. */
    private boolean errorReported = false;

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
                    MediaStatus status = client.getMediaStatus();
                    int state = status != null
                        ? status.getPlayerState()
                        : MediaStatus.PLAYER_STATE_UNKNOWN;
                    // A fatal receiver error (e.g. a segment 410 after the live
                    // session was GC'd) surfaces as IDLE with reason ERROR.
                    // Signal JS once so the sender re-establishes a fresh
                    // session; an in-flight recovery load goes IDLE/INTERRUPTED,
                    // not ERROR, so it won't misfire.
                    if (state == MediaStatus.PLAYER_STATE_IDLE
                            && status.getIdleReason() == MediaStatus.IDLE_REASON_ERROR) {
                        if (!errorReported) {
                            errorReported = true;
                            notifyCastError(lastGoodPosition);
                        }
                    } else {
                        if (state != MediaStatus.PLAYER_STATE_IDLE) errorReported = false;
                        double time = client.getApproximateStreamPosition() / 1000.0;
                        double duration = client.getStreamDuration() / 1000.0;
                        boolean paused = client.isPaused();
                        boolean buffering = state == MediaStatus.PLAYER_STATE_BUFFERING
                            || state == MediaStatus.PLAYER_STATE_LOADING;
                        if (time > 0) lastGoodPosition = time;
                        // Device (receiver) volume isn't part of MediaStatus — read it
                        // off the session each tick so external changes (TV remote, cast
                        // dialog) mirror back into the sender slider within a poll.
                        double volume = castSession.getVolume();
                        boolean muted = castSession.isMute();
                        notifyJSTime(time, duration, paused, buffering, volume, muted);
                    }
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

    @Override
    protected void handleOnDestroy() {
        MediaRouter.getInstance(getContext()).removeCallback(routeCallback);
    }
}
