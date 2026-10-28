package media.fliks.app;

import android.content.Context;
import android.os.Build;
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
import com.google.android.gms.cast.CastDevice;
import com.google.android.gms.cast.CastMediaControlIntent;
import com.google.android.gms.cast.MediaInfo;
import com.google.android.gms.cast.MediaLoadRequestData;
import com.google.android.gms.cast.MediaMetadata;
import com.google.android.gms.cast.MediaStatus;
import com.google.android.gms.cast.MediaTrack;
import com.google.android.gms.cast.framework.CastContext;
import com.google.android.gms.cast.framework.CastSession;
import com.google.android.gms.cast.framework.SessionManager;
import com.google.android.gms.cast.framework.SessionManagerListener;
import com.google.android.gms.cast.framework.media.RemoteMediaClient;
import com.google.android.gms.common.api.Status;
import com.google.android.gms.common.images.WebImage;

import android.net.Uri;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** Capacitor plugin for Google Cast on Android; JS side is `NativeCast` (initialize, requestSession, loadMedia, play,
 *  pause, seek, stop). */
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
    private boolean routeDiscoveryActive = false;
    private MediaRouter mediaRouter;

    /** A dead process left a cast behind and CAF is not resuming it: join the receiver by hand. */
    private boolean rejoinArmed = false;
    private boolean rejoining = false;
    /** Active scan for the saved receiver, bounded by HUNT_MS. */
    private boolean hunting = false;
    /** A connected session went through this process, so its end is a real stop. */
    private boolean live = false;
    private static final long HUNT_MS = 60_000;

    /** Cast session updates stay on the main thread: some Play Services versions call these off the UI thread. */
    private final SessionManagerListener<CastSession> sessionListener = new SessionManagerListener<CastSession>() {
        @Override
        public void onSessionStarted(CastSession session, String sessionId) {
            runOnMainThread(() -> onConnected(session));
        }
        @Override
        public void onSessionEnded(CastSession session, int error) {
            runOnMainThread(() -> {
                sessionPending = false;
                castSession = null;
                unlistenReceiver(session);
                if (live) prefs().edit().clear().apply();
                live = false;
                releaseWifiLock();
                notifyJS("connected", false);
            });
        }
        @Override
        public void onSessionResumed(CastSession session, boolean wasSuspended) {
            runOnMainThread(() -> onConnected(session));
        }
        @Override
        public void onSessionSuspended(CastSession session, int reason) {
            releaseWifiLock();
        }
        @Override
        public void onSessionStarting(CastSession session) {
            // Set immediately on the callback thread (volatile): posting to the main looper lets the chooser dialog be destroyed
            // first, and castPickerDismissed would fire as if the user cancelled.
            sessionPending = true;
        }
        @Override
        public void onSessionStartFailed(CastSession session, int error) {
            runOnMainThread(() -> {
                sessionPending = false;
                rejoining = false;
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
                if (hunting && hasSavedCast()) {
                    Log.d(TAG, "rejoin armed after resume failure");
                    rejoinArmed = true;
                    MediaRouter router = router();
                    for (MediaRouter.RouteInfo route : router.getRoutes()) tryRejoin(router, route);
                }
            });
        }
    };

    private void onConnected(CastSession session) {
        sessionPending = false;
        castSession = session;
        live = true;
        rejoinArmed = false;
        listenReceiver(session);
        acquireWifiLock();
        JSObject resume = savedResumeState(session.getSessionId());
        boolean rejoined = rejoining;
        rejoining = false;
        RemoteMediaClient client = session.getRemoteMediaClient();
        if (resume == null || client == null) {
            // A rejoin that found another cast than ours has nothing to take back.
            if (rejoined) {
                Log.d(TAG, "rejoin found no saved cast, ending session " + session.getSessionId());
                sessionManager.endCurrentSession(false);
            } else {
                notifyJS("connected", true);
            }
            return;
        }
        if (client.getMediaInfo() != null) {
            handBack(client, resume);
            return;
        }
        // A joined session only knows its media after the first status.
        client.registerCallback(new RemoteMediaClient.Callback() {
            @Override
            public void onStatusUpdated() {
                client.unregisterCallback(this);
                handBack(client, resume);
            }
        });
        client.requestStatus();
    }

    private void handBack(RemoteMediaClient client, JSObject resume) {
        if (client.getMediaInfo() == null) {
            notifyJS("connected", true);
            return;
        }
        startMediaPolling(client);
        notifyResumed(resume);
    }

    /** Selecting a route launches the receiver when it is not running, so only join a device
     *  whose status still reads what it read while we cast. */
    private void tryRejoin(MediaRouter router, MediaRouter.RouteInfo route) {
        if (!rejoinArmed || sessionPending) return;
        CastDevice device = CastDevice.getFromBundle(route.getExtras());
        android.content.SharedPreferences p = prefs();
        if (device == null || !device.getDeviceId().equals(p.getString("deviceId", null))) return;
        if (!String.valueOf(route.getDescription()).equals(p.getString("routeStatus", null))) return;
        rejoinArmed = false;
        rejoining = true;
        Log.d(TAG, "rejoin: selecting saved route " + route.getName());
        router.selectRoute(route);
    }

    /** Passive route discovery, active only while hunting for a cast to take back. */
    private final MediaRouter.Callback routeCallback = new MediaRouter.Callback() {
        @Override
        public void onRouteAdded(MediaRouter router, MediaRouter.RouteInfo route) {
            notifyRoutesChanged();
            tryRejoin(router, route);
        }
        @Override
        public void onRouteChanged(MediaRouter router, MediaRouter.RouteInfo route) {
            notifyRoutesChanged();
            tryRejoin(router, route);
        }
        @Override
        public void onRouteRemoved(MediaRouter router, MediaRouter.RouteInfo route) {
            notifyRoutesChanged();
        }
    };

    private void acquireWifiLock() {
        if (wifiLock == null) {
            WifiManager wm = (WifiManager) getContext().getApplicationContext()
                    .getSystemService(Context.WIFI_SERVICE);
            @SuppressWarnings("deprecation")
            int mode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                    ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                    : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
            wifiLock = wm.createWifiLock(mode, "fliks:cast");
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

    /** Receiver messages on the Fliks namespace (qoe samples, player errors) go to JS verbatim. */
    private static final String FLIKS_NAMESPACE = "urn:x-cast:media.fliks.app";

    private void listenReceiver(CastSession session) {
        try {
            session.setMessageReceivedCallbacks(FLIKS_NAMESPACE, (device, ns, message) -> notifyReceiverMessage(ns, message));
        } catch (Exception e) {
            Log.w(TAG, "receiver message channel failed", e);
        }
    }

    private void unlistenReceiver(CastSession session) {
        try {
            session.removeMessageReceivedCallbacks(FLIKS_NAMESPACE);
        } catch (Exception ignored) {
            // channel already gone with the session
        }
    }

    private void notifyReceiverMessage(String namespace, String message) {
        String js = "window.dispatchEvent(new CustomEvent('castReceiverMessage', { detail: { namespace: "
            + JSONObject.quote(namespace) + ", message: " + JSONObject.quote(message) + " } }));";
        getBridge().getWebView().post(() ->
            getBridge().getWebView().evaluateJavascript(js, null)
        );
    }

    private void notifyResumed(JSObject resume) {
        String js = "window.dispatchEvent(new CustomEvent('castStateChanged', { detail: { connected: true, resume: "
            + resume + " } }));";
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

    private void notifyRoutesChanged() {
        boolean available = hasCastRoute();
        String js = "window.dispatchEvent(new CustomEvent('castDevicesChanged'));"
            + "window.dispatchEvent(new CustomEvent('castAvailabilityChanged', { detail: { available: "
            + available + " } }));";
        getBridge().getWebView().post(() ->
            getBridge().getWebView().evaluateJavascript(js, null)
        );
    }

    /** Whether any receiver is reachable right now. Drives the Cast entry
     *  points, which stay hidden while nothing can be cast to. */
    private boolean hasCastRoute() {
        MediaRouteSelector selector = buildCastSelector();
        for (MediaRouter.RouteInfo route : router().getRoutes()) {
            if (!route.isDefaultOrBluetooth() && route.matchesSelector(selector)) return true;
        }
        return false;
    }

    private void notifyJSTime(double time, double duration, boolean paused, boolean buffering,
                             double volume, boolean muted, boolean ended) {
        String js = "window.dispatchEvent(new CustomEvent('castMediaUpdate', { detail: { "
            + "currentTime: " + time + ", duration: " + duration + ", isPaused: " + paused
            + ", buffering: " + buffering + ", volume: " + volume + ", muted: " + muted
            + ", ended: " + ended
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

    private boolean setUpCast() {
        if (castContext != null) return true;
        try {
            castContext = CastContext.getSharedInstance(getContext());
        } catch (Exception e) {
            // Expected where the Cast module is absent (Android TV): one line, no stack.
            Log.w(TAG, "Cast unavailable: " + e.getMessage());
            return false;
        }
        sessionManager = castContext.getSessionManager();
        sessionManager.addSessionManagerListener(sessionListener, CastSession.class);
        CastSession current = sessionManager.getCurrentCastSession();
        if (!hasSavedCast()) {
            prefs().edit().clear().apply();
        } else if (current == null || !current.isConnected()) {
            // No current session: CAF attempts no resume (app update), so rejoin right away.
            rejoinArmed = current == null;
            Log.d(TAG, "saved cast pending, active scan, rejoinArmed=" + rejoinArmed);
            setHunting(true);
            mainHandler.postDelayed(() -> {
                rejoinArmed = false;
                setHunting(false);
            }, HUNT_MS);
        }
        startRouteDiscovery();
        return true;
    }

    @PluginMethod()
    public void initialize(PluginCall call) {
        runOnMainThread(() -> {
            if (!setUpCast()) {
                call.resolve(new JSObject().put("available", false));
                return;
            }
            // A session outlives the WebView (Back, reopening from the Cast
            // notification): hand it and the sender's saved state back.
            castSession = sessionManager.getCurrentCastSession();
            if (castSession != null) listenReceiver(castSession);
            // Discovery has only just started, so this is usually false; the
            // route callback raises it as soon as a receiver answers.
            JSObject result = new JSObject().put("available", hasCastRoute());
            RemoteMediaClient client = castSession != null && castSession.isConnected()
                ? castSession.getRemoteMediaClient() : null;
            if (client != null) {
                result.put("connected", true);
                JSObject resume = savedResumeState(castSession.getSessionId());
                if (resume != null && client.getMediaInfo() != null) {
                    result.put("resume", resume);
                    startMediaPolling(client);
                }
            }
            call.resolve(result);
        });
    }

    private android.content.SharedPreferences prefs() {
        return getContext().getSharedPreferences("fliks_cast", Context.MODE_PRIVATE);
    }

    /** The sender's cast state, keyed by its Cast session id so a process restart takes the
     *  session back and a later session never picks up an old cast's state. */
    @PluginMethod()
    public void setResumeState(PluginCall call) {
        JSObject state = call.getObject("state");
        runOnMainThread(() -> {
            if (castSession != null && castSession.isConnected() && state != null) {
                prefs().edit()
                    .putString("sessionId", castSession.getSessionId())
                    .putString("deviceId", castSession.getCastDevice().getDeviceId())
                    .putString("routeStatus", String.valueOf(
                        router().getSelectedRoute().getDescription()))
                    .putString("state", state.toString())
                    .apply();
            }
            call.resolve();
        });
    }

    /** Partial prefs (an older build's) never arm a rejoin. */
    private boolean hasSavedCast() {
        android.content.SharedPreferences p = prefs();
        return p.contains("sessionId") && p.contains("deviceId") && p.contains("routeStatus") && p.contains("state");
    }

    private JSObject savedResumeState(String sessionId) {
        android.content.SharedPreferences p = prefs();
        String state = p.getString("state", null);
        if (sessionId == null || state == null || !sessionId.equals(p.getString("sessionId", null))) return null;
        try {
            return new JSObject(state);
        } catch (org.json.JSONException e) {
            return null;
        }
    }

    @PluginMethod()
    public void isConnected(PluginCall call) {
        runOnMainThread(() -> {
            boolean connected = castSession != null && castSession.isConnected();
            call.resolve(new JSObject().put("connected", connected));
        });
    }

    /** Shared by requestSession (native dialog) and getCastDevices/selectCastDevice (custom list). */
    /** The SDK's own selector, so the category matches the receiver id in
     *  CastOptions: a device is only discovered for the app it was asked for. */
    private MediaRouteSelector buildCastSelector() {
        if (castContext != null) return castContext.getMergedSelector();
        return new MediaRouteSelector.Builder()
            .addControlCategory(CastMediaControlIntent.categoryForCast(
                getContext().getString(R.string.cast_receiver_app_id)))
            .build();
    }

    /** MediaRouter holds its instances weakly: an unreferenced one is collected with routeCallback, discovery included. */
    private MediaRouter router() {
        if (mediaRouter == null) mediaRouter = MediaRouter.getInstance(getContext());
        return mediaRouter;
    }

    /** CALLBACK_FLAG_REQUEST_DISCOVERY makes the router discover at all: without it no provider scans
     *  and getRoutes() holds only the default route. */
    private void startRouteDiscovery() {
        if (routeDiscoveryActive) return;
        addRouteCallback();
        routeDiscoveryActive = true;
    }

    /** Re-adding the callback only updates its flags. */
    private void addRouteCallback() {
        int flags = MediaRouter.CALLBACK_FLAG_REQUEST_DISCOVERY
            | (hunting ? MediaRouter.CALLBACK_FLAG_PERFORM_ACTIVE_SCAN : 0);
        router().addCallback(buildCastSelector(), routeCallback, flags);
    }

    private void setHunting(boolean on) {
        if (hunting == on) return;
        hunting = on;
        if (routeDiscoveryActive) addRouteCallback();
    }

    private void stopRouteDiscovery() {
        if (!routeDiscoveryActive) return;
        router().removeCallback(routeCallback);
        routeDiscoveryActive = false;
    }

    /** Discovery costs battery and network, so it lives with the foreground and
     *  not with the plugin: an existing session is unaffected by dropping it. */
    @Override
    protected void handleOnStart() {
        super.handleOnStart();
        if (castContext != null) runOnMainThread(this::startRouteDiscovery);
    }

    @Override
    protected void handleOnStop() {
        super.handleOnStop();
        runOnMainThread(this::stopRouteDiscovery);
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
            MediaRouter router = router();
            // Which row the caller is already casting to: the selected route, and
            // only while a session actually stands behind it.
            String connectedId = castSession != null && castSession.isConnected()
                ? router.getSelectedRoute().getId()
                : null;
            JSArray devices = new JSArray();
            for (MediaRouter.RouteInfo route : router.getRoutes()) {
                if (route.isDefaultOrBluetooth() || !route.matchesSelector(selector)) continue;
                JSObject device = new JSObject();
                device.put("id", route.getId());
                device.put("name", route.getName());
                // The device's model, not route.getDescription(): that one turns into
                // the name of whatever receiver is running, so the row read "Fliks".
                CastDevice castDevice = CastDevice.getFromBundle(route.getExtras());
                String modelName = castDevice != null ? castDevice.getModelName() : null;
                if (modelName != null) device.put("modelName", modelName);
                device.put("connected", route.getId().equals(connectedId));
                devices.put(device);
            }
            call.resolve(new JSObject().put("devices", devices));
        });
    }

    @PluginMethod()
    public void selectCastDevice(PluginCall call) {
        runOnMainThread(() -> {
            String id = call.getString("id");
            MediaRouter router = router();
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
            // Selecting the already-selected route fires no session callback: report the state instead of leaving the caller waiting.
            if (id.equals(router.getSelectedRoute().getId())) {
                boolean connected = castSession != null && castSession.isConnected();
                Log.d(TAG, "selectCastDevice: already the selected route, connected=" + connected);
                notifyJS("connected", connected);
                if (!connected) notifyPickerDismissed();
                call.resolve();
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

        // customData is the side-channel the Fliks receiver reads to identify the media (mediaId, episodeId);
        // the Default Media Receiver ignores it. JSObject is a JSONObject, so it is forwarded as is.
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
        // Always set the style: the receiver's defaults otherwise mask the user's prefs when the LOAD has no preselected subtitle track.
        mediaInfoBuilder.setTextTrackStyle(CastSubtitleStyle.build(styleSpec));

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

        client.load(requestBuilder.build()).setResultCallback(result -> {
            Status status = result.getStatus();
            if (!status.isSuccess()) {
                call.reject("Load failed: " + status.getStatusCode() + " " + status.getStatusMessage(), "LOAD_FAILED");
                return;
            }

            // Apply text track style after load (Default Media Receiver ignores it in MediaInfo)
            pollHandler = mainHandler;
            pollHandler.postDelayed(() -> {
                try {
                    client.setTextTrackStyle(CastSubtitleStyle.build(styleSpec));
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
        });
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
    public void sendMessage(PluginCall call) {
        runOnMainThread(() -> {
            String message = call.getString("message");
            if (message == null || castSession == null || !castSession.isConnected()) {
                call.reject("No Cast session");
                return;
            }
            castSession.sendMessage(FLIKS_NAMESPACE, message).setResultCallback(status -> {
                if (status.isSuccess()) call.resolve();
                else call.reject("sendMessage failed: " + status.getStatusCode());
            });
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
                List<MediaTrack> tracks = CastTracks.mediaTracks(client);
                long audioId = tracks != null ? CastTracks.activeTrackId(client, tracks, MediaTrack.TYPE_AUDIO) : -1;
                CastTracks.setActiveTracks(client, audioId, trackId > 0 ? trackId : -1);
            }
            call.resolve();
        });
    }

    /** Switches the receiver's audio rendition through setActiveMediaTracks (the receiver mirrors Shaka's HLS renditions as AUDIO tracks),
     *  no ffmpeg restart. Resolves {@code success: false} when no track matches, so the caller falls back to a reload. */
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
            List<MediaTrack> tracks = CastTracks.mediaTracks(client);
            if (tracks == null || tracks.isEmpty()) {
                call.resolve(new JSObject().put("success", false));
                return;
            }
            // Match by NAME (unique per rendition, verbatim from master.m3u8): Shaka rewrites LANGUAGE from 639-2 to 639-1,
            // so language only substitutes for a missing name when unambiguous.
            MediaTrack target = null;
            MediaTrack sameLanguage = null;
            int sameLanguageCount = 0;
            for (MediaTrack t : tracks) {
                if (t.getType() != MediaTrack.TYPE_AUDIO) continue;
                if (name.equals(t.getName())) {
                    target = t;
                    break;
                }
                String tag = t.getLanguage();
                if (tag != null && language.equals(tag.split("[-_]")[0])) {
                    sameLanguage = t;
                    sameLanguageCount++;
                }
            }
            if (target == null && sameLanguageCount == 1) target = sameLanguage;
            if (target == null) {
                call.resolve(new JSObject().put("success", false));
                return;
            }
            CastTracks.setActiveTracks(client, target.getId(), CastTracks.activeTrackId(client, tracks, MediaTrack.TYPE_TEXT));
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
                    // A fatal receiver error (e.g. a segment 410 after the live session was GC'd) shows as IDLE with reason ERROR: signal JS
                    // once to re-establish the session. A recovery load goes IDLE/INTERRUPTED, so it doesn't misfire.
                    if (state == MediaStatus.PLAYER_STATE_IDLE
                            && status.getIdleReason() == MediaStatus.IDLE_REASON_ERROR) {
                        if (!errorReported) {
                            errorReported = true;
                            notifyCastError(lastGoodPosition);
                        }
                    } else {
                        if (state != MediaStatus.PLAYER_STATE_IDLE) errorReported = false;
                        double time = client.getApproximateStreamPosition() / 1000.0;
                        // MediaInfo.UNKNOWN_DURATION (-1) until the receiver has loaded the media.
                        double duration = Math.max(0, client.getStreamDuration()) / 1000.0;
                        boolean paused = client.isPaused();
                        boolean buffering = state == MediaStatus.PLAYER_STATE_BUFFERING
                            || state == MediaStatus.PLAYER_STATE_LOADING;
                        if (time > 0) lastGoodPosition = time;
                        // Device volume isn't in MediaStatus: read it off the session each tick so TV remote or cast dialog changes reach the slider.
                        double volume = castSession.getVolume();
                        boolean muted = castSession.isMute();
                        boolean ended = state == MediaStatus.PLAYER_STATE_IDLE
                            && status.getIdleReason() == MediaStatus.IDLE_REASON_FINISHED;
                        notifyJSTime(time, duration, paused, buffering, volume, muted, ended);
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
        if (castSession != null) unlistenReceiver(castSession);
        router().removeCallback(routeCallback);
    }
}
