package media.fliks.app;

import android.graphics.Color;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.FrameLayout;

import androidx.annotation.NonNull;
import androidx.annotation.OptIn;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.TrackGroup;
import androidx.media3.common.TrackSelectionOverride;
import androidx.media3.common.Tracks;
import androidx.media3.common.VideoSize;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.LoadControl;
import androidx.media3.exoplayer.analytics.AnalyticsListener;
import androidx.media3.exoplayer.hls.HlsMediaSource;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.exoplayer.source.LoadEventInfo;
import androidx.media3.exoplayer.source.MediaLoadData;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.CaptionStyleCompat;
import androidx.media3.ui.SubtitleView;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Capacitor plugin wrapping ExoPlayer for native HLS playback.
 * Renders behind the WebView — the Angular UI overlays on top.
 */
@CapacitorPlugin(name = "NativePlayer")
public class NativePlayerPlugin extends Plugin {
    private static final String DIAG_TAG = "FlksPlayerDiag";

    private ExoPlayer player;
    private FrameLayout wrapper;
    private AspectRatioFrameLayout aspectFrame;
    /** Pending subtitle track ID — applied when onTracksChanged fires */
    private String pendingSubtitleTrackId = null;
    /** Pending video height to force. -1 = none, 0 = auto (clear override). */
    private int pendingVideoHeight = -1;
    private SurfaceView surfaceView;
    private SubtitleView subtitleView;
    private DefaultHttpDataSource.Factory httpFactory;
    private String currentHlsUrl;
    private int lastAudioTrackCount = -1;
    private final List<MediaItem.SubtitleConfiguration> subtitleConfigs = new ArrayList<>();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private Handler positionHandler;
    private Runnable positionRunnable;

    /** Diagnostic state — tracks last STATE_BUFFERING entry so we can
     *  report how long we were stuck. Reset on state transitions. */
    private long bufferingEnteredAt = 0;
    private String lastRequestedUri = "";

    // ── Lifecycle ──

    @PluginMethod()
    public void create(PluginCall call) {
        mainHandler.post(() -> {
            if (surfaceView != null) {
                call.resolve();
                return;
            }

            // Black wrapper covers letterbox areas
            wrapper = new FrameLayout(getContext());
            wrapper.setBackgroundColor(Color.BLACK);

            // AspectRatioFrameLayout maintains video aspect ratio.
            // SurfaceView (vs TextureView): the HW composer pushes the decoded
            // buffer straight to the panel, preserving HDR10/HLG metadata. With
            // TextureView the GPU composes the buffer as an SDR texture and the
            // HDR signal is lost — visible as a black screen for HEVC HDR
            // playback on devices that strict-reject mis-tagged buffers
            // (Samsung S25 etc.).
            //
            // SurfaceView starts out black before the first buffer is committed
            // (its backing surface is BLACK by default), so the alpha-0 trick
            // that hid the TextureView "stretched first frame" flash isn't
            // needed — the AspectRatioFrameLayout sizes the SurfaceView to the
            // video aspect via onVideoSizeChanged before any frame is shown.
            aspectFrame = new AspectRatioFrameLayout(getContext());
            aspectFrame.setResizeMode(AspectRatioFrameLayout.RESIZE_MODE_FIT);

            surfaceView = new SurfaceView(getContext());
            aspectFrame.addView(surfaceView, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT));

            wrapper.addView(aspectFrame, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    Gravity.CENTER));

            // Z-order: 0=wrapper (video) → 1=subtitleView → 2+=WebView (controls)
            android.webkit.WebView webView = getBridge().getWebView();
            ViewGroup webViewParent = (ViewGroup) webView.getParent();
            // Black on the parent ViewGroup covers the single-frame gap on
            // player close: between removeView(wrapper) and the WebView
            // re-rendering as opaque, the layout briefly shows whatever is
            // behind webViewParent (the activity windowBackground, which on
            // some Capacitor / device combos defaults to white despite the
            // theme). BLACK here removes that window from ever showing.
            webViewParent.setBackgroundColor(Color.BLACK);

            webViewParent.addView(wrapper, 0, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT));

            subtitleView = new SubtitleView(getContext());
            webViewParent.addView(subtitleView, 1, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT));

            // Transparent WebView so native player shows through
            webView.setBackgroundColor(Color.TRANSPARENT);
            webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);

            // Keep screen on during playback
            getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

            call.resolve();
        });
    }

    @PluginMethod()
    public void destroy(PluginCall call) {
        mainHandler.post(() -> {
            // Restore an opaque BLACK WebView FIRST, before removing the
            // wrapper — between removeView(wrapper) and the next compositing
            // pass the WebView would otherwise still be TRANSPARENT, exposing
            // the activity windowBackground (Light theme = white) for one
            // frame. Setting BLACK before the removeView calls means the
            // very next composited frame already has BLACK in place.
            android.webkit.WebView webView = getBridge().getWebView();
            if (webView != null) webView.setBackgroundColor(Color.BLACK);
            stopPositionUpdates();
            if (player != null) {
                player.release();
                player = null;
            }
            if (subtitleView != null) {
                ViewGroup subParent = (ViewGroup) subtitleView.getParent();
                if (subParent != null) subParent.removeView(subtitleView);
                subtitleView = null;
            }
            if (wrapper != null) {
                ViewGroup parent = (ViewGroup) wrapper.getParent();
                if (parent != null) parent.removeView(wrapper);
                wrapper = null;
                aspectFrame = null;
                surfaceView = null;
            }
            subtitleConfigs.clear();
            // Allow screen to sleep again
            getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            call.resolve();
        });
    }

    @PluginMethod()
    public void resize(PluginCall call) {
        // Wrapper is MATCH_PARENT — no resize needed. Kept for interface compatibility.
        call.resolve();
    }

    // ── Playback ──

    @OptIn(markerClass = UnstableApi.class)
    @PluginMethod()
    public void load(PluginCall call) {
        String url = call.getString("url");
        double startTime = call.getDouble("startTime", 0.0);
        JSObject headers = call.getObject("headers", new JSObject());
        JSArray subtitles = call.getArray("subtitles", new JSArray());
        boolean offline = call.getBoolean("offline", false);

        if (url == null) {
            call.reject("URL is required");
            return;
        }

        mainHandler.post(() -> {
            if (player != null) player.release();

            // HTTP data source with auth headers
            Map<String, String> headerMap = new HashMap<>();
            if (headers != null) {
                for (java.util.Iterator<String> it = headers.keys(); it.hasNext(); ) {
                    String key = it.next();
                    try { headerMap.put(key, headers.getString(key)); }
                    catch (Exception ignored) {}
                }
            }

            httpFactory = new DefaultHttpDataSource.Factory()
                    .setDefaultRequestProperties(headerMap)
                    .setConnectTimeoutMs(15_000)
                    .setReadTimeoutMs(30_000)
                    .setAllowCrossProtocolRedirects(true);

            currentHlsUrl = url;
            subtitleConfigs.clear();

            // Pre-load all subtitle configs from the load call
            if (subtitles != null) {
                for (int i = 0; i < subtitles.length(); i++) {
                    try {
                        org.json.JSONObject sub = subtitles.getJSONObject(i);
                        subtitleConfigs.add(
                                new MediaItem.SubtitleConfiguration.Builder(Uri.parse(sub.getString("url")))
                                        .setMimeType(MimeTypes.TEXT_VTT)
                                        .setLanguage(sub.optString("language", "und"))
                                        .setLabel(sub.optString("label", "Subtitle"))
                                        .build());
                    } catch (Exception ignored) {}
                }
            }

            // Offline: CacheDataSource (cached HLS) wrapped in DefaultDataSource
            // (adds file:// support for local subtitle VTTs).
            // Online: DefaultDataSource with HTTP factory.
            DataSource.Factory dataSourceFactory = offline
                    ? new DefaultDataSource.Factory(getContext(), FlixDownloadUtil.getCacheDataSourceFactory(getContext()))
                    : new DefaultDataSource.Factory(getContext(), httpFactory);
            DefaultMediaSourceFactory mediaSourceFactory = new DefaultMediaSourceFactory(dataSourceFactory);
            // 500ms instead of ExoPlayer's default 2500ms — short-segment LAN HLS.
            LoadControl loadControl = new DefaultLoadControl.Builder()
                    .setBufferDurationsMs(3000, 8000, 500, 3000)
                    .build();
            // Renderers tuned for AV receivers / TVs that decode surround:
            // - setEnableAudioFloatOutput(false) keeps the audio path on 16-bit
            //   integer PCM, which is the only mode that allows AC-3 / E-AC-3
            //   passthrough (float output forces ExoPlayer to decode + downmix
            //   in the app, so the TV would only ever see stereo PCM).
            // - setEnableDecoderFallback(true) lets the renderer fall back to
            //   another decoder when the preferred one rejects the format
            //   (e.g. some Android TV SoCs ship a buggy AC-3 decoder).
            DefaultRenderersFactory renderersFactory =
                    new DefaultRenderersFactory(getContext())
                            .setEnableAudioFloatOutput(false)
                            .setEnableDecoderFallback(true);
            player = new ExoPlayer.Builder(getContext())
                    .setRenderersFactory(renderersFactory)
                    .setMediaSourceFactory(mediaSourceFactory)
                    .setLoadControl(loadControl)
                    .setWakeMode(C.WAKE_MODE_NETWORK)
                    .build();
            // CONTENT_TYPE_MOVIE flags the stream as cinematic so the framework
            // routes it through the surround-capable HDMI path; without this
            // (default UNKNOWN) some TVs negotiate a stereo-only PCM track.
            player.setAudioAttributes(
                    new AudioAttributes.Builder()
                            .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                            .setUsage(C.USAGE_MEDIA)
                            .build(),
                    /* handleAudioFocus= */ true);
            if (surfaceView != null) player.setVideoSurfaceView(surfaceView);

            player.addListener(new Player.Listener() {
                @Override
                public void onPlaybackStateChanged(int state) {
                    Log.d(DIAG_TAG, "[state] " + stateName(state)
                            + " pos=" + player.getCurrentPosition()
                            + " buf=" + player.getBufferedPosition()
                            + " playWhenReady=" + player.getPlayWhenReady()
                            + " isPlaying=" + player.isPlaying());
                    if (state == Player.STATE_BUFFERING) {
                        bufferingEnteredAt = System.currentTimeMillis();
                    } else if (bufferingEnteredAt > 0) {
                        long delta = System.currentTimeMillis() - bufferingEnteredAt;
                        Log.d(DIAG_TAG, "[state] BUFFERING exited after " + delta + "ms");
                        bufferingEnteredAt = 0;
                    }
                    switch (state) {
                        case Player.STATE_BUFFERING: emitStateChanged("buffering"); break;
                        case Player.STATE_READY: emitStateChanged(player.getPlayWhenReady() ? "playing" : "paused"); break;
                        case Player.STATE_ENDED: emitStateChanged("ended"); break;
                        default: emitStateChanged("idle");
                    }
                }

                @Override public void onIsPlayingChanged(boolean isPlaying) {
                    Log.d(DIAG_TAG, "[playing] " + isPlaying
                            + " state=" + stateName(player.getPlaybackState())
                            + " pos=" + player.getCurrentPosition());
                    if (isPlaying) {
                        emitStateChanged("playing");
                    } else if (player.getPlaybackState() == Player.STATE_BUFFERING) {
                        emitStateChanged("buffering");
                    } else if (player.getPlaybackState() == Player.STATE_READY) {
                        emitStateChanged("paused");
                    }
                }


                @Override public void onPlayerError(@NonNull PlaybackException error) {
                    Log.e(DIAG_TAG, "[error] code=" + error.errorCode
                            + " name=" + error.getErrorCodeName()
                            + " msg=" + error.getMessage()
                            + " lastUri=" + lastRequestedUri, error);
                    emitError(error.errorCode, error.getMessage());
                }

                @Override public void onTracksChanged(@NonNull Tracks tracks) {
                    Log.d(DIAG_TAG, "[tracks] groups=" + tracks.getGroups().size());
                    emitTracksChanged();
                    // Apply pending subtitle selection now that tracks are ready
                    if (pendingSubtitleTrackId != null) {
                        if (applySubtitleTrack(pendingSubtitleTrackId)) {
                            pendingSubtitleTrackId = null;
                        }
                    }
                    // Apply pending video override once variants are known
                    if (pendingVideoHeight > 0) {
                        if (applyVideoOverrideByHeight(pendingVideoHeight)) {
                            pendingVideoHeight = -1;
                        }
                    }
                }

                @Override public void onVideoSizeChanged(@NonNull VideoSize videoSize) {
                    if (aspectFrame != null && videoSize.width > 0 && videoSize.height > 0) {
                        aspectFrame.setAspectRatio(
                                videoSize.width * videoSize.pixelWidthHeightRatio / videoSize.height);
                    }
                }

                @Override public void onRenderedFirstFrame() {
                    Log.d(DIAG_TAG, "[firstFrame] pos=" + player.getCurrentPosition());
                    emitFirstFrame();
                }

                @Override public void onCues(@NonNull androidx.media3.common.text.CueGroup cueGroup) {
                    if (subtitleView != null) {
                        subtitleView.setCues(cueGroup.cues);
                    }
                }
            });

            // Diagnostic AnalyticsListener: captures every HLS segment + manifest
            // load so when the player gets stuck buffering we can pin down WHICH
            // request stalled / errored. Track last requested URI on the player
            // instance so PlayerError can include it.
            player.addAnalyticsListener(new AnalyticsListener() {
                @Override
                public void onLoadStarted(@NonNull EventTime eventTime,
                                          @NonNull LoadEventInfo loadEventInfo,
                                          @NonNull MediaLoadData mediaLoadData) {
                    lastRequestedUri = loadEventInfo.uri.toString();
                    Log.d(DIAG_TAG, "[load>>] dataType=" + mediaLoadData.dataType
                            + " uri=" + lastRequestedUri);
                }

                @Override
                public void onLoadCompleted(@NonNull EventTime eventTime,
                                            @NonNull LoadEventInfo loadEventInfo,
                                            @NonNull MediaLoadData mediaLoadData) {
                    Log.d(DIAG_TAG, "[load<<] dataType=" + mediaLoadData.dataType
                            + " bytes=" + loadEventInfo.bytesLoaded
                            + " elapsed=" + loadEventInfo.loadDurationMs + "ms"
                            + " uri=" + loadEventInfo.uri);
                }

                @Override
                public void onLoadError(@NonNull EventTime eventTime,
                                        @NonNull LoadEventInfo loadEventInfo,
                                        @NonNull MediaLoadData mediaLoadData,
                                        @NonNull IOException error,
                                        boolean wasCanceled) {
                    Log.w(DIAG_TAG, "[load!!] dataType=" + mediaLoadData.dataType
                            + " wasCanceled=" + wasCanceled
                            + " uri=" + loadEventInfo.uri
                            + " err=" + error.getMessage());
                }
            });

            MediaItem.Builder itemBuilder = new MediaItem.Builder()
                    .setUri(Uri.parse(currentHlsUrl));
            if (!subtitleConfigs.isEmpty()) {
                itemBuilder.setSubtitleConfigurations(subtitleConfigs);
            }
            player.setMediaItem(itemBuilder.build());
            lastAudioTrackCount = -1; // Reset so emitTracksChanged fires for new media

            // Disable text tracks by default — user selects via UI
            player.setTrackSelectionParameters(
                    player.getTrackSelectionParameters().buildUpon()
                            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
                            .build());
            // seekTo BEFORE prepare: ExoPlayer queues the seek and applies it
            // once sources are ready. Calling seekTo AFTER prepare can race with
            // ProgressiveMediaPeriod (used by SubtitleConfiguration wrappers)
            // mid-preparation and trip its `isPendingReset` assertion — surfaces
            // as an intermittent IllegalStateException at startup (~1 in 6 plays).
            if (startTime > 0) player.seekTo((long) (startTime * 1000));
            player.prepare();
            player.setPlayWhenReady(true);
            startPositionUpdates();
            call.resolve();
        });
    }

    @PluginMethod()
    public void play(PluginCall call) {
        mainHandler.post(() -> { if (player != null) player.play(); call.resolve(); });
    }

    @PluginMethod()
    public void pause(PluginCall call) {
        mainHandler.post(() -> { if (player != null) player.pause(); call.resolve(); });
    }

    @PluginMethod()
    public void seek(PluginCall call) {
        double position = call.getDouble("position", 0.0);
        mainHandler.post(() -> {
            if (player != null) {
                // Drop stale cues before the seek: SubtitleView holds whatever was
                // last set until onCues fires again, and the TextRenderer may take
                // several hundred ms to emit new cues for an external VTT after
                // seekTo — leaving the previous line visible and reading as
                // "subtitles shifted" until the next cue lands.
                if (subtitleView != null) {
                    subtitleView.setCues(java.util.Collections.emptyList());
                }
                player.seekTo((long) (position * 1000));
            }
            call.resolve();
        });
    }

    @PluginMethod()
    public void stop(PluginCall call) {
        mainHandler.post(() -> { stopPositionUpdates(); if (player != null) player.stop(); call.resolve(); });
    }

    // ── Audio Tracks ──

    @PluginMethod()
    public void getAudioTracks(PluginCall call) {
        mainHandler.post(() -> {
            JSObject result = new JSObject();
            result.put("tracks", buildAudioTrackList());
            call.resolve(result);
        });
    }

    @PluginMethod()
    public void selectAudioTrack(PluginCall call) {
        String id = call.getString("id");
        if (id == null) { call.reject("id is required"); return; }

        mainHandler.post(() -> {
            if (player == null) { call.reject("Player not initialized"); return; }

            int targetFlatIdx;
            try { targetFlatIdx = Integer.parseInt(id.replace("audio-", "")); }
            catch (NumberFormatException e) { call.reject("Invalid track id: " + id); return; }

            // Find the group and format index matching the flat audio index
            int flatIdx = 0;
            for (Tracks.Group group : player.getCurrentTracks().getGroups()) {
                if (group.getType() == C.TRACK_TYPE_AUDIO) {
                    for (int i = 0; i < group.length; i++) {
                        if (flatIdx == targetFlatIdx) {
                            player.setTrackSelectionParameters(
                                    player.getTrackSelectionParameters().buildUpon()
                                            .setOverrideForType(
                                                    new TrackSelectionOverride(group.getMediaTrackGroup(), i))
                                            .build());
                            call.resolve();
                            return;
                        }
                        flatIdx++;
                    }
                }
            }
            call.reject("Audio track not found: " + id);
        });
    }

    // ── Subtitle Tracks ──

    @PluginMethod()
    public void getSubtitleTracks(PluginCall call) {
        mainHandler.post(() -> {
            JSArray tracks = new JSArray();
            if (player != null) {
                int idx = 0;
                for (Tracks.Group group : player.getCurrentTracks().getGroups()) {
                    if (group.getType() == C.TRACK_TYPE_TEXT) {
                        for (int i = 0; i < group.length; i++) {
                            var fmt = group.getTrackFormat(i);
                            JSObject t = new JSObject();
                            t.put("id", "text-" + idx);
                            t.put("language", fmt.language != null ? fmt.language : "und");
                            t.put("label", fmt.label != null ? fmt.label : (fmt.language != null ? fmt.language : "Track " + idx));
                            tracks.put(t);
                            idx++;
                        }
                    }
                }
            }
            call.resolve(new JSObject().put("tracks", tracks));
        });
    }

    @PluginMethod()
    public void selectSubtitleTrack(PluginCall call) {
        String id = call.getString("id");
        mainHandler.post(() -> {
            if (player == null) { call.reject("Player not initialized"); return; }

            if (id == null) {
                pendingSubtitleTrackId = null;
                player.setTrackSelectionParameters(
                        player.getTrackSelectionParameters().buildUpon()
                                .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true).build());
                call.resolve();
                return;
            }

            // Try to apply now; if tracks aren't ready, store as pending
            if (!applySubtitleTrack(id)) {
                pendingSubtitleTrackId = id;
            }
            call.resolve();
        });
    }

    @PluginMethod()
    public void addExternalSubtitle(PluginCall call) {
        // Subtitles are preloaded at load() time. This just returns an ID
        // for the frontend to track. The actual selection is done via selectSubtitleTrack.
        String id = call.getString("url", "ext-sub-" + System.currentTimeMillis());
        call.resolve(new JSObject().put("id", id));
    }

    // ── Subtitle Style ──

    @PluginMethod()
    public void setSubtitleStyle(PluginCall call) {
        float fontScale = call.getFloat("fontScale", 1.0f);
        String fgColor = call.getString("foregroundColor", "#FFFFFF");
        String bgColor = call.getString("backgroundColor", "transparent");
        String edgeType = call.getString("edgeType", "drop_shadow");
        int bottomMargin = call.getInt("bottomMarginPercent", 10);

        mainHandler.post(() -> {
            if (subtitleView == null) { call.resolve(); return; }

            int fg = parseColor(fgColor, Color.WHITE);
            int bg = bgColor.equals("transparent") ? Color.TRANSPARENT : parseColor(bgColor, Color.TRANSPARENT);
            int edge;
            switch (edgeType) {
                case "outline": edge = CaptionStyleCompat.EDGE_TYPE_OUTLINE; break;
                case "raised": edge = CaptionStyleCompat.EDGE_TYPE_RAISED; break;
                case "none": edge = CaptionStyleCompat.EDGE_TYPE_NONE; break;
                default: edge = CaptionStyleCompat.EDGE_TYPE_DROP_SHADOW; break;
            }

            CaptionStyleCompat style = new CaptionStyleCompat(
                    fg,                              // foreground
                    bg,                              // background
                    Color.TRANSPARENT,               // window (around the cue box)
                    edge,                            // edge type
                    Color.BLACK,                     // edge color
                    null);                           // typeface (null = default)

            subtitleView.setStyle(style);
            subtitleView.setFixedTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 18f * fontScale);

            // Bottom margin via padding
            int screenH = getActivity().getWindow().getDecorView().getHeight();
            int paddingBottom = (int) (screenH * bottomMargin / 100f);
            subtitleView.setPadding(0, 0, 0, paddingBottom);

            call.resolve();
        });
    }

    private int parseColor(String hex, int fallback) {
        try {
            return Color.parseColor(hex);
        } catch (Exception e) {
            return fallback;
        }
    }

    // ── Brightness ──

    @PluginMethod()
    public void setBrightness(PluginCall call) {
        float brightness = call.getFloat("brightness", -1f);
        mainHandler.post(() -> {
            WindowManager.LayoutParams lp = getActivity().getWindow().getAttributes();
            lp.screenBrightness = brightness; // -1 = system default, 0..1 = manual
            getActivity().getWindow().setAttributes(lp);

            // Dim subtitle view when screen is at max brightness (HDR mode)
            if (subtitleView != null) {
                subtitleView.setAlpha(brightness >= 1.0f ? 0.5f : 1.0f);
            }

            call.resolve();
        });
    }

    // ── Quality ──

    @PluginMethod()
    public void setMaxResolution(PluginCall call) {
        int width = call.getInt("width", 0);
        int height = call.getInt("height", 0);
        mainHandler.post(() -> {
            if (player == null) {
                // Called from JS before load() has built the ExoPlayer instance
                // (player.ts pins a saved quality between createNativeEngine and
                // engine.load to keep the bandwidth-probe phase off the wrong
                // variant). Queue the height — onTracksChanged consumes
                // pendingVideoHeight once load() runs and tracks resolve, so the
                // pin still applies on the first track-selection pass. Resolve
                // (not reject) — the caller doesn't await, and rejecting here
                // surfaces as an "Uncaught (in promise)" console error.
                pendingVideoHeight = height > 0 ? height : -1;
                call.resolve();
                return;
            }

            if (width <= 0 || height <= 0) {
                // Auto: clear manual override and the soft size cap → ExoPlayer
                // re-runs adaptive selection across every advertised variant.
                pendingVideoHeight = -1;
                player.setTrackSelectionParameters(
                        player.getTrackSelectionParameters().buildUpon()
                                .clearOverridesOfType(C.TRACK_TYPE_VIDEO)
                                .clearVideoSizeConstraints()
                                .build());
                call.resolve();
                return;
            }

            // Set a soft cap on max video size FIRST. This filters out
            // higher-than-target variants from ExoPlayer's initial track
            // selection — without it the player starts fetching the top
            // rung from the master and only honours the override after
            // onTracksChanged fires, costing a wasted ffmpeg session
            // (visible in the backend log as 'Quality change [X]:
            // 2160p-hdr → 1080p-hdr, killing old session').
            player.setTrackSelectionParameters(
                    player.getTrackSelectionParameters().buildUpon()
                            .setMaxVideoSize(width, height)
                            .build());
            // Then pin to the exact variant once it's known (onTracksChanged).
            // The override is a manual pick, not just a cap, so a 2160p
            // variant with height 2016 (cinema 4K) doesn't sneak in when
            // the user picked 1080p.
            if (!applyVideoOverrideByHeight(height)) {
                pendingVideoHeight = height;
            } else {
                pendingVideoHeight = -1;
            }
            call.resolve();
        });
    }

    /**
     * Pin the video track to the variant whose height best matches target.
     * Returns true if an override was applied, false if no video group found yet.
     */
    @OptIn(markerClass = UnstableApi.class)
    private boolean applyVideoOverrideByHeight(int targetHeight) {
        if (player == null) return false;
        for (Tracks.Group group : player.getCurrentTracks().getGroups()) {
            if (group.getType() != C.TRACK_TYPE_VIDEO) continue;
            TrackGroup mediaGroup = group.getMediaTrackGroup();
            int bestIdx = -1;
            int bestDiff = Integer.MAX_VALUE;
            int bestBitrate = -1;
            for (int i = 0; i < mediaGroup.length; i++) {
                var fmt = mediaGroup.getFormat(i);
                if (fmt.height <= 0) continue;
                int diff = Math.abs(fmt.height - targetHeight);
                // Tie-break by bitrate so that when a remux variant and a
                // transcode profile share the same height (source 1080p +
                // 1080p transcode), we pick the higher-bitrate remux and
                // avoid spinning up a redundant FFmpeg session.
                if (diff < bestDiff
                        || (diff == bestDiff && fmt.bitrate > bestBitrate)) {
                    bestDiff = diff;
                    bestBitrate = fmt.bitrate;
                    bestIdx = i;
                }
            }
            if (bestIdx >= 0) {
                player.setTrackSelectionParameters(
                        player.getTrackSelectionParameters().buildUpon()
                                .setOverrideForType(
                                        new TrackSelectionOverride(mediaGroup, bestIdx))
                                .build());
                return true;
            }
        }
        return false;
    }

    // ── State ──

    @PluginMethod()
    public void getPosition(PluginCall call) {
        mainHandler.post(() -> {
            JSObject r = new JSObject();
            if (player != null) {
                r.put("position", player.getCurrentPosition() / 1000.0);
                r.put("duration", player.getDuration() != C.TIME_UNSET ? player.getDuration() / 1000.0 : 0);
                r.put("buffered", player.getBufferedPosition() / 1000.0);
            } else {
                r.put("position", 0); r.put("duration", 0); r.put("buffered", 0);
            }
            call.resolve(r);
        });
    }

    @PluginMethod()
    public void setPlaybackRate(PluginCall call) {
        float rate = call.getFloat("rate", 1.0f);
        mainHandler.post(() -> { if (player != null) player.setPlaybackSpeed(rate); call.resolve(); });
    }

    // ── Private helpers ──

    /** Try to select a subtitle track by ID (e.g. "text-0"). Returns true if found. */
    private boolean applySubtitleTrack(String id) {
        if (player == null) return false;

        int targetIndex;
        try { targetIndex = Integer.parseInt(id.replace("text-", "")); }
        catch (NumberFormatException e) { return false; }

        // ExoPlayer may auto-detect extra text tracks (CEA-608 from HLS) before our sidecar subs.
        // Offset by the number of non-sidecar text tracks so text-0 maps to our first SubtitleConfiguration.
        int totalTextGroups = 0;
        for (Tracks.Group group : player.getCurrentTracks().getGroups()) {
            if (group.getType() == C.TRACK_TYPE_TEXT) totalTextGroups++;
        }
        int sidecarOffset = totalTextGroups - subtitleConfigs.size();
        if (sidecarOffset < 0) sidecarOffset = 0;
        int exoIndex = targetIndex + sidecarOffset;

        int idx = 0;
        for (Tracks.Group group : player.getCurrentTracks().getGroups()) {
            if (group.getType() == C.TRACK_TYPE_TEXT) {
                if (idx == exoIndex) {
                    player.setTrackSelectionParameters(
                            player.getTrackSelectionParameters().buildUpon()
                                    .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                                    .setOverrideForType(
                                            new TrackSelectionOverride(group.getMediaTrackGroup(), 0))
                                    .build());
                    return true;
                }
                idx++;
            }
        }
        return false;
    }

    private JSArray buildAudioTrackList() {
        JSArray list = new JSArray();
        if (player == null) return list;
        int flatIdx = 0;
        for (Tracks.Group group : player.getCurrentTracks().getGroups()) {
            if (group.getType() == C.TRACK_TYPE_AUDIO) {
                for (int i = 0; i < group.length; i++) {
                    var fmt = group.getTrackFormat(i);
                    JSObject t = new JSObject();
                    t.put("id", "audio-" + flatIdx);
                    String lang = fmt.language != null ? fmt.language : "und";
                    t.put("language", lang);
                    // Build a human-readable label: "Français (AAC 6ch)"
                    String displayLang = langToDisplayName(lang);
                    String codec = fmt.sampleMimeType != null
                            ? fmt.sampleMimeType.replace("audio/", "").toUpperCase()
                            : "";
                    String channels = fmt.channelCount > 0 ? fmt.channelCount + "ch" : "";
                    String detail = (codec + " " + channels).trim();
                    t.put("label", displayLang + (detail.isEmpty() ? "" : " (" + detail + ")"));
                    t.put("selected", group.isTrackSelected(i));
                    list.put(t);
                    flatIdx++;
                }
            }
        }
        return list;
    }

    /** Convert ISO 639-2/B or 639-1 language code to display name. */
    private String langToDisplayName(String code) {
        if (code == null || code.equals("und")) return "Unknown";
        Locale loc = Locale.forLanguageTag(code);
        String name = loc.getDisplayLanguage(Locale.getDefault());
        if (!name.isEmpty() && !name.equals(code)) {
            return name.substring(0, 1).toUpperCase() + name.substring(1);
        }
        // Fallback for 3-letter codes (fre→fr, eng→en)
        loc = new Locale(code);
        name = loc.getDisplayLanguage(Locale.getDefault());
        if (!name.isEmpty() && !name.equals(code)) {
            return name.substring(0, 1).toUpperCase() + name.substring(1);
        }
        return code;
    }

    private String lastEmittedState = "";
    private long lastNonBufferingAt = 0;
    private static final long BUFFERING_GUARD_MS = 300;

    private static String stateName(int state) {
        switch (state) {
            case Player.STATE_IDLE: return "IDLE";
            case Player.STATE_BUFFERING: return "BUFFERING";
            case Player.STATE_READY: return "READY";
            case Player.STATE_ENDED: return "ENDED";
            default: return "UNKNOWN(" + state + ")";
        }
    }

    private void emitStateChanged(String state) {
        // Hysteresis on BUFFERING: ExoPlayer can briefly dip below the
        // rebuffer threshold after a seek and oscillate ready ↔ buffering
        // a few times in rapid succession. Swallow a BUFFERING emit if a
        // playable state was reported < 300ms ago — wait for it to
        // actually settle into BUFFERING before the spinner shows.
        long now = android.os.SystemClock.uptimeMillis();
        if ("buffering".equals(state) && now - lastNonBufferingAt < BUFFERING_GUARD_MS) {
            return;
        }
        if (!"buffering".equals(state)) lastNonBufferingAt = now;
        if (state.equals(lastEmittedState)) return;
        lastEmittedState = state;
        getBridge().getWebView().evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('nativePlayerStateChanged',{detail:{state:'" + state + "'}}));", null);
    }

    private void emitError(int code, String message) {
        String safe = message != null ? message.replace("'", "\\'") : "Unknown error";
        getBridge().getWebView().evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('nativePlayerError',{detail:{code:" + code + ",message:'" + safe + "'}}));", null);
    }

    private void emitFirstFrame() {
        getBridge().getWebView().evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('nativePlayerFirstFrame'));", null);
    }

    private void emitTracksChanged() {
        JSArray audio = buildAudioTrackList();
        // Only emit when audio track count actually changes — ExoPlayer fires
        // onTracksChanged on every HLS segment transition which would clear the UI.
        if (audio.length() == lastAudioTrackCount) return;
        lastAudioTrackCount = audio.length();
        getBridge().getWebView().evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('nativePlayerTracksChanged',{detail:{audioTracks:" + audio + ",subtitleTracks:[]}}));", null);
    }

    private void startPositionUpdates() {
        stopPositionUpdates();
        positionHandler = new Handler(Looper.getMainLooper());
        positionRunnable = new Runnable() {
            @Override public void run() {
                if (player != null && player.isPlaying()) {
                    double pos = player.getCurrentPosition() / 1000.0;
                    double dur = player.getDuration() != C.TIME_UNSET ? player.getDuration() / 1000.0 : 0;
                    double buf = player.getBufferedPosition() / 1000.0;
                    getBridge().getWebView().evaluateJavascript(
                            "window.dispatchEvent(new CustomEvent('nativePlayerTimeUpdate',{detail:{position:" + pos + ",duration:" + dur + ",buffered:" + buf + "}}));", null);
                }
                positionHandler.postDelayed(this, 1000);
            }
        };
        positionHandler.postDelayed(positionRunnable, 1000);
    }

    private void stopPositionUpdates() {
        if (positionHandler != null && positionRunnable != null) {
            positionHandler.removeCallbacks(positionRunnable);
            positionHandler = null;
            positionRunnable = null;
        }
    }
}
