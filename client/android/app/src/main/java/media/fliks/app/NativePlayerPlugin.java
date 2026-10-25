package media.fliks.app;

import static media.fliks.app.NativePlayerUtil.*;
import media.fliks.app.NativePlayerUtil.PcmOnlyRenderersFactory;

import android.graphics.Color;
import android.os.Build;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
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
import androidx.media3.common.MediaMetadata;
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
import androidx.media3.exoplayer.DecoderCounters;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.LoadControl;
import androidx.media3.exoplayer.PlayerMessage;
import androidx.media3.exoplayer.analytics.AnalyticsListener;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.exoplayer.upstream.CmcdConfiguration;
import androidx.media3.exoplayer.upstream.DefaultBandwidthMeter;
import androidx.media3.session.MediaSession;
import java.util.ArrayList;
import java.util.List;
import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.CaptionStyleCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.HashMap;
import java.util.Map;

/**
 * Capacitor plugin wrapping ExoPlayer for native HLS playback.
 * Renders behind the WebView — the Angular UI overlays on top.
 */
@CapacitorPlugin(name = "NativePlayer")
public class NativePlayerPlugin extends Plugin {
    private ExoPlayer player;
    private FrameLayout wrapper;
    private AspectRatioFrameLayout aspectFrame;
    /** Pending subtitle track ID — applied when onTracksChanged fires */
    private String pendingSubtitleTrackId = null;
    /** Pending video height to force. -1 = none, 0 = auto (clear override). */
    private int pendingVideoHeight = -1;
    private SurfaceView surfaceView;
    // Black view over the surface until the first frame; see create().
    private View shutter;
    private SubtitleOverlay subtitles;
    private boolean fillScreen = false;
    private VideoCropLayout.Crop crop;
    private int[] viewport;
    // Presented size from onVideoSizeChanged (pixelWidthHeightRatio-corrected); 0 until known.
    private float displayWidth = 0f;
    private float displayHeight = 0f;
    private DefaultHttpDataSource.Factory httpFactory;
    private String currentHlsUrl;
    private String lastAudioTracksJson = null;
    // Cold-prepare bootstrap: Media3 1.10.1's HLS source can drop the video group when EAC3 audio enables first, so no decoder
    // is allocated and playback stalls in BUFFERING. A seek re-runs `selectTracks()`; this flag arms a one-shot micro-seek in `onTracksChanged`.
    private boolean videoBootstrapDone = false;
    // Set once the first frame is signalled to the WebView, so `onRenderedFirstFrame` (unreliable on some devices)
    // and the `onIsPlayingChanged` fallback don't both dispatch it. Reset on each load().
    private boolean firstFrameSignaled = false;
    // Set when the video renderer enables: tells a slow start from the cold-prepare race, where only the latter
    // needs the unstick seek. Reset on each load().
    private boolean videoRendererEnabled = false;
    // QoE counters, cumulative since the last load().
    private boolean qoeCmcd = false;
    private long qoeBandwidthBps = -1;
    // From configure(), before load(): a fresh player is built per load, so these are re-applied each time.
    private String preferredAudioLanguage = "";
    private long initialBandwidthBps = -1;
    private String qoeDecoderName = null;
    private Boolean qoeHwDecoder = null;
    // Only exists while background audio is on: it is what keeps playback alive off-screen.
    private MediaSession mediaSession;
    private boolean hasNext = false;
    private boolean hasPrevious = false;
    private Boolean liked;
    private boolean seekButtons;
    private final List<MediaItem.SubtitleConfiguration> subtitleConfigs = new ArrayList<>();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private Handler positionHandler;
    private Runnable positionRunnable;

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

            // SurfaceView, not TextureView: the HW composer sends the buffer straight to the panel and keeps HDR10/HLG metadata;
            // TextureView composes an SDR texture, a black screen for HEVC HDR on devices that reject mis-tagged buffers (Samsung S25).
            aspectFrame = new AspectRatioFrameLayout(getContext());
            aspectFrame.setResizeMode(AspectRatioFrameLayout.RESIZE_MODE_FIT);

            // Rotation, PiP and split-screen resize the wrapper without a fresh
            // onVideoSizeChanged, so the crop is re-fit on every wrapper layout.
            wrapper.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or_, ob) -> layoutVideo());

            surfaceView = new SurfaceView(getContext());
            aspectFrame.addView(surfaceView, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT));

            wrapper.addView(aspectFrame, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    Gravity.CENTER));

            // The decoder commits its first buffer to the full-size surface before onVideoSizeChanged arrives, so it shows stretched;
            // lifted in emitFirstFrame(), queued after the size event.
            shutter = new View(getContext());
            shutter.setBackgroundColor(Color.BLACK);
            wrapper.addView(shutter, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT));

            // Z-order: 0=wrapper (video) → 1/2=SubtitleOverlay layers
            //          → 3+=WebView (controls)
            android.webkit.WebView webView = getBridge().getWebView();
            ViewGroup webViewParent = (ViewGroup) webView.getParent();
            // Black on the parent covers the one-frame gap on close, when the activity windowBackground (white on some
            // Capacitor/device combos) would show between removeView(wrapper) and the WebView turning opaque.
            webViewParent.setBackgroundColor(Color.BLACK);

            webViewParent.addView(wrapper, 0, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT));

            subtitles = new SubtitleOverlay(getContext(), webViewParent, wrapper, surfaceView);

            // Transparent WebView so native player shows through
            webView.setBackgroundColor(Color.TRANSPARENT);
            webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);

            call.resolve();
        });
    }

    @PluginMethod()
    public void destroy(PluginCall call) {
        mainHandler.post(() -> {
            // Restore the opaque BLACK WebView before removing the wrapper, or the transparent WebView exposes the
            // windowBackground (white in the Light theme) for one frame.
            android.webkit.WebView webView = getBridge().getWebView();
            if (webView != null) webView.setBackgroundColor(Color.BLACK);
            stopPositionUpdates();
            muteMessages.clear();
            muteRanges = new double[0][];
            releaseMediaSession();
            if (player != null) {
                player.release();
                player = null;
            }
            if (subtitles != null) {
                subtitles.detach();
                subtitles = null;
            }
            if (wrapper != null) {
                ViewGroup parent = (ViewGroup) wrapper.getParent();
                if (parent != null) parent.removeView(wrapper);
                wrapper = null;
                aspectFrame = null;
                surfaceView = null;
                shutter = null;
            }
            crop = null;
            viewport = null;
            fillScreen = false;
            displayWidth = 0f;
            displayHeight = 0f;
            subtitleConfigs.clear();
            call.resolve();
        });
    }

    /** The player container's rectangle in CSS px; a negative width or height fills the WebView's parent. */
    @PluginMethod()
    public void resize(PluginCall call) {
        int x = call.getInt("x", 0);
        int y = call.getInt("y", 0);
        int w = call.getInt("width", -1);
        int h = call.getInt("height", -1);
        mainHandler.post(() -> {
            viewport = w < 0 || h < 0 ? null : new int[] {x, y, w, h};
            applyViewport();
            call.resolve();
        });
    }

    /** Video and text subtitles sit on the viewport, scaled from CSS px to the WebView's pixels. */
    private void applyViewport() {
        if (wrapper == null) return;
        int[] box = {ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT, 0, 0};
        if (viewport != null) {
            android.webkit.WebView webView = getBridge().getWebView();
            float d = getContext().getResources().getDisplayMetrics().density;
            box = new int[] {
                    Math.round(viewport[2] * d),
                    Math.round(viewport[3] * d),
                    webView.getLeft() + Math.round(viewport[0] * d),
                    webView.getTop() + Math.round(viewport[1] * d)};
        }
        place(wrapper, box);
        if (subtitles != null) subtitles.setViewport(box);
    }

    /** Edits the params the host layout generated (a CoordinatorLayout in Capacitor): a fresh FrameLayout one crashes its measure. */
    static void place(View v, int[] box) {
        ViewGroup.MarginLayoutParams lp = (ViewGroup.MarginLayoutParams) v.getLayoutParams();
        lp.width = box[0];
        lp.height = box[1];
        lp.leftMargin = box[2];
        lp.topMargin = box[3];
        v.setLayoutParams(lp);
    }

    /** Screen stays awake while the session is advancing or stalled mid-play;
     *  pause, end and idle release it. On the view so a detach frees it too. */
    private void syncKeepScreenOn() {
        if (surfaceView == null || player == null) return;
        int state = player.getPlaybackState();
        surfaceView.setKeepScreenOn(player.getPlayWhenReady()
                && (state == Player.STATE_READY || state == Player.STATE_BUFFERING));
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
        boolean backgroundAudio = call.getBoolean("backgroundAudio", false);
        String title = call.getString("title", "");
        String artist = call.getString("artist", "");
        String artworkUrl = call.getString("artworkUrl");

        if (url == null) {
            call.reject("URL is required");
            return;
        }

        mainHandler.post(() -> {
            if (!backgroundAudio) releaseMediaSession();
            cancelMuteMessages();
            if (player != null) player.release();

            // Clear stale cues: ExoPlayer.release() keeps them and a fresh load starts with text rendering disabled,
            // so the old cue would sit on screen until a seek (notably after the silent session-expired recovery).
            if (this.subtitles != null) this.subtitles.clear();

            // A new item's crop (if any) is re-sent by the TS layer after load().
            crop = null;
            displayWidth = 0f;
            displayHeight = 0f;
            layoutVideo();

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
            pendingSubtitleTrackId = null;

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
                                        .setSelectionFlags(sub.optBoolean("forced", false)
                                                ? C.SELECTION_FLAG_FORCED : 0)
                                        .build());
                    } catch (Exception ignored) {}
                }
            }

            // Offline: CacheDataSource in a DefaultDataSource (file:// for local VTTs). Online: DefaultDataSource with HTTP.
            final DataSource.Factory dataSourceFactory = offline
                    ? new DefaultDataSource.Factory(getContext(), FlixDownloadUtil.getCacheDataSourceFactory(getContext()))
                    : new DefaultDataSource.Factory(getContext(), httpFactory);
            // Buffer in multiples of the ~6s HLS segment: 18s min, 48s max (under the backend's 90s seek-restart threshold),
            // bufferForPlaybackMs 500ms for a snappy start, one full segment after a rebuffer.
            LoadControl loadControl = new DefaultLoadControl.Builder()
                    .setBufferDurationsMs(18000, 48000, 500, 6000)
                    .build();
            // Renderers for AV receivers and TVs: 16-bit PCM (no float output) keeps AC-3/E-AC-3 passthrough possible;
            // decoder fallback covers TV SoCs with a buggy AC-3 decoder. Volume is ignored on passthrough, so a mute gate needs PCM.
            muteSinkPlayer = muteRanges.length > 0;
            DefaultRenderersFactory renderersFactory =
                    (muteSinkPlayer
                            ? new PcmOnlyRenderersFactory(getContext())
                            : new DefaultRenderersFactory(getContext()))
                            .setEnableAudioFloatOutput(false)
                            .setEnableDecoderFallback(true);
            // DefaultMediaSourceFactory autodetects HLS or progressive and runs the modern subtitle pipeline (external WebVTT
            // to media3 cues); HlsMediaSource.Factory would mean re-implementing package-private Media3 APIs.
            DefaultMediaSourceFactory mediaSourceFactory =
                    new DefaultMediaSourceFactory(dataSourceFactory)
                            .setLoadErrorHandlingPolicy(new RetryHttp404LoadErrorPolicy());
            // Offline cache keys are the bare URL, so CMCD stays off there.
            qoeCmcd = !offline && androidx.media3.common.util.Util.inferContentType(Uri.parse(url)) == C.CONTENT_TYPE_HLS;
            if (!offline) {
                final String cmcdSid = java.util.UUID.randomUUID().toString();
                mediaSourceFactory.setCmcdConfigurationFactory(item ->
                        new CmcdConfiguration(cmcdSid, null, new CmcdConfiguration.RequestConfig() {},
                                CmcdConfiguration.MODE_QUERY_PARAMETER));
            }
            ExoPlayer.Builder playerBuilder = new ExoPlayer.Builder(getContext())
                    .setRenderersFactory(renderersFactory)
                    .setMediaSourceFactory(mediaSourceFactory)
                    .setLoadControl(loadControl)
                    .setWakeMode(C.WAKE_MODE_NETWORK)
                    .setHandleAudioBecomingNoisy(true)
                    .setSeekBackIncrementMs(10_000)
                    .setSeekForwardIncrementMs(10_000);
            if (initialBandwidthBps > 0) {
                playerBuilder.setBandwidthMeter(new DefaultBandwidthMeter.Builder(getContext())
                        .setInitialBitrateEstimate(initialBandwidthBps).build());
            }
            player = playerBuilder.build();
            // CONTENT_TYPE_MOVIE routes through the surround-capable HDMI path; the default UNKNOWN can negotiate stereo-only PCM.
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
                    syncKeepScreenOn();
                    if (state == Player.STATE_READY) applyGate();
                    // The 1 Hz push can be a second old: a stall must read the buffer it starts on.
                    emitPosition();
                    switch (state) {
                        case Player.STATE_BUFFERING: emitStateChanged("buffering"); break;
                        case Player.STATE_READY: emitStateChanged(player.getPlayWhenReady() ? "playing" : "paused"); break;
                        case Player.STATE_ENDED: emitStateChanged("ended"); break;
                        default: emitStateChanged("idle");
                    }
                }

                @Override public void onPositionDiscontinuity(
                        @NonNull Player.PositionInfo oldPosition,
                        @NonNull Player.PositionInfo newPosition, int reason) {
                    applyGate();
                    emitPosition();
                }

                @Override public void onPlayWhenReadyChanged(boolean playWhenReady, int reason) {
                    syncKeepScreenOn();
                }

                @Override public void onIsPlayingChanged(boolean isPlaying) {
                    if (isPlaying) {
                        // Playback advancing means frames are presenting: lift the loading veil even if onRenderedFirstFrame misfired,
                        // instead of waiting ~2 s for the position fallback in native-engine.ts.
                        emitFirstFrame();
                        emitStateChanged("playing");
                    } else if (player.getPlaybackState() == Player.STATE_BUFFERING) {
                        emitStateChanged("buffering");
                    } else if (player.getPlaybackState() == Player.STATE_READY) {
                        emitStateChanged("paused");
                    }
                }

                @Override public void onPlayerError(@NonNull PlaybackException error) {
                    emitError(error.errorCode, error.getMessage());
                }

                @Override public void onTracksChanged(@NonNull Tracks tracks) {
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
                    // Cold-prepare bootstrap, at most once per load(): from the second ExoPlayer in a JVM (notably EAC3 5.1) the video renderer
                    // may never enable and state pins at BUFFERING. A `seekTo()` cancels the loads and re-runs `selectTracks()`, which wakes it.
                    if (!videoBootstrapDone) {
                        boolean videoSelected = false;
                        boolean videoSupported = false;
                        for (Tracks.Group g : tracks.getGroups()) {
                            if (g.getType() != C.TRACK_TYPE_VIDEO) continue;
                            if (g.isSelected()) videoSelected = true;
                            for (int i = 0; i < g.length; i++) {
                                if (g.isTrackSupported(i)) {
                                    videoSupported = true;
                                    break;
                                }
                            }
                        }
                        if (videoSelected) {
                            // Video track picked: nudge with a 1 ms seek only if the video renderer never enabled (onVideoEnabled) and state is still
                            // BUFFERING; a healthy slow start is left alone, as seeking would cancel in-flight loads. 1 ms is under one frame at 24 fps.
                            videoBootstrapDone = true;
                            mainHandler.postDelayed(() -> {
                                if (player == null) return;
                                if (!videoRendererEnabled
                                        && player.getPlaybackState() == Player.STATE_BUFFERING) {
                                    player.seekTo(player.getCurrentPosition() + 1);
                                }
                            }, 500);
                        } else if (videoSupported) {
                            // Video group dropped entirely (audio surfaced first): wait 200 ms for the format to arrive before the recovery seek.
                            videoBootstrapDone = true;
                            mainHandler.postDelayed(() -> {
                                if (player == null) return;
                                player.seekTo(player.getCurrentPosition() + 1);
                            }, 200);
                        }
                    }
                }

                @Override public void onVideoSizeChanged(@NonNull VideoSize videoSize) {
                    if (videoSize.width > 0 && videoSize.height > 0) {
                        displayWidth = videoSize.width * videoSize.pixelWidthHeightRatio;
                        displayHeight = videoSize.height;
                        if (aspectFrame != null) {
                            aspectFrame.setAspectRatio(displayWidth / displayHeight);
                        }
                    }
                    layoutVideo();
                }

                @Override public void onRenderedFirstFrame() {
                    emitFirstFrame();
                }

                @Override public void onCues(@NonNull androidx.media3.common.text.CueGroup cueGroup) {
                    if (NativePlayerPlugin.this.subtitles != null) NativePlayerPlugin.this.subtitles.onCues(cueGroup);
                }

            });

            // The video renderer enabling separates a healthy start from the cold-prepare race;
            // the bootstrap watchdog reads it to seek only when genuinely stuck.
            player.addAnalyticsListener(new AnalyticsListener() {
                @Override public void onVideoEnabled(
                        @NonNull AnalyticsListener.EventTime eventTime,
                        @NonNull DecoderCounters counters) {
                    videoRendererEnabled = true;
                }
                @Override public void onBandwidthEstimate(
                        @NonNull AnalyticsListener.EventTime eventTime, int totalLoadTimeMs,
                        long totalBytesLoaded, long bitrateEstimate) {
                    qoeBandwidthBps = bitrateEstimate;
                }
                @Override public void onVideoDecoderInitialized(
                        @NonNull AnalyticsListener.EventTime eventTime, @NonNull String decoderName,
                        long initializedTimestampMs, long initializationDurationMs) {
                    qoeDecoderName = decoderName;
                    qoeHwDecoder = isHardwareDecoder(decoderName);
                }
            });
            qoeBandwidthBps = -1;
            qoeDecoderName = null;
            qoeHwDecoder = null;

            MediaItem.Builder itemBuilder = new MediaItem.Builder()
                    .setUri(Uri.parse(currentHlsUrl));
            if (!subtitleConfigs.isEmpty()) {
                itemBuilder.setSubtitleConfigurations(subtitleConfigs);
            }
            itemBuilder.setMediaMetadata(new MediaMetadata.Builder()
                    .setTitle(title).setArtist(artist)
                    .setArtworkUri(artworkUrl != null ? Uri.parse(artworkUrl) : null).build());
            player.setMediaItem(itemBuilder.build());
            // Swapping the player keeps the notification in place across episodes.
            if (mediaSession != null) mediaSession.setPlayer(player);
            else if (backgroundAudio) startMediaSession();
            lastAudioTracksJson = null; // Reset so emitTracksChanged fires for new media
            videoBootstrapDone = false; // Arm cold-prepare bug bootstrap
            firstFrameSignaled = false; // Re-arm the first-frame veil signal
            if (shutter != null) shutter.setVisibility(View.VISIBLE);
            videoRendererEnabled = false; // Re-arm the cold-prepare renderer probe

            // Disable text tracks by default — user selects via UI
            player.setTrackSelectionParameters(
                    player.getTrackSelectionParameters().buildUpon()
                            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
                            .setPreferredAudioLanguages(audioLanguages())
                            .build());
            // seekTo before prepare: after it, the seek can race ProgressiveMediaPeriod mid-preparation and trip `isPendingReset`
            // (an intermittent IllegalStateException, about 1 in 6 plays).
            if (startTime > 0) player.seekTo((long) (startTime * 1000));
            player.prepare();
            player.setPlayWhenReady(true);
            startPositionUpdates();
            scheduleMuteMessages();
            applyGate();
            call.resolve();
        });
    }

    // ── Mute ranges ──

    private static final double MUTE_LEAD_S = 0.02;
    private static final double MUTE_MERGE_GAP_S = 0.2;

    /** Sorted, disjoint, gap-merged [start, end] pairs in seconds. */
    private double[][] muteRanges = new double[0][];
    private final List<PlayerMessage> muteMessages = new ArrayList<>();
    private boolean muteSinkPlayer = false;

    @PluginMethod()
    public void setMuteRanges(PluginCall call) {
        JSArray raw = call.getArray("ranges", new JSArray());
        List<double[]> merged = new ArrayList<>();
        for (int i = 0; i < raw.length(); i++) {
            org.json.JSONObject r = raw.optJSONObject(i);
            if (r == null) continue;
            double s = r.optDouble("start", Double.NaN);
            double e = r.optDouble("end", Double.NaN);
            if (Double.isNaN(s) || Double.isNaN(e) || e <= s) continue;
            double[] last = merged.isEmpty() ? null : merged.get(merged.size() - 1);
            if (last != null && s - last[1] <= MUTE_MERGE_GAP_S) last[1] = Math.max(last[1], e);
            else merged.add(new double[] {s, e});
        }
        double[][] next = merged.toArray(new double[0][]);
        mainHandler.post(() -> {
            muteRanges = next;
            scheduleMuteMessages();
            applyGate();
            call.resolve();
        });
    }

    private boolean inMute(double t) {
        for (double[] r : muteRanges) {
            if (t < r[0] - MUTE_LEAD_S) return false;
            if (t < r[1]) return true;
        }
        return false;
    }

    private void applyGate() {
        if (player == null) return;
        player.setVolume(inMute(player.getCurrentPosition() / 1000.0) ? 0f : 1f);
    }

    private void cancelMuteMessages() {
        for (PlayerMessage m : muteMessages) m.cancel();
        muteMessages.clear();
    }

    /** Lead only on the start edge: the mute window is [start - lead, end). */
    @OptIn(markerClass = UnstableApi.class)
    private void scheduleMuteMessages() {
        cancelMuteMessages();
        if (player == null) return;
        for (double[] r : muteRanges) {
            for (int k = 0; k < 2; k++) {
                double at = k == 0 ? r[0] - MUTE_LEAD_S : r[1];
                muteMessages.add(player.createMessage((type, payload) -> applyGate())
                        .setLooper(Looper.getMainLooper())
                        .setPosition(Math.max(0L, Math.round(at * 1000)))
                        .setDeleteAfterDelivery(false)
                        .send());
            }
        }
    }

    /** Screen lock or a leave without PiP: unless background audio keeps a media
     *  session, playback is muted by the OS yet keeps the locks and the download. */
    @Override
    protected void handleOnStop() {
        super.handleOnStop();
        boolean inPip = android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.N
                && getActivity().isInPictureInPictureMode();
        if (player != null && mediaSession == null && !inPip) {
            player.pause();
        }
    }

    /** The PiP window was closed: the activity is stopped yet still reports PiP, so handleOnStop kept playing. */
    void onPipClosed() {
        if (player != null && mediaSession == null) player.pause();
    }

    private void startMediaSession() {
        mediaSession = QueueSession.build(getContext(), player, "local", new QueueSession.Handlers() {
            @Override public void previous() {
                if (hasPrevious) emitWindowEvent("nativePlayerPrevious");
                else if (player != null) player.seekTo(0);
            }
            @Override public void next() { emitWindowEvent("nativePlayerNext"); }
            @Override public void stop() { emitWindowEvent("nativePlayerStop"); }
            @Override public void toggleLike() { emitWindowEvent("nativePlayerToggleLike"); }
        });
        QueueSession.setState(getContext(), mediaSession, hasNext, liked, seekButtons);
        PlaybackService.attach(getContext(), mediaSession);
    }

    private void emitWindowEvent(String name) {
        getBridge().getWebView().evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('" + name + "'));", null);
    }

    @PluginMethod()
    public void setQueueNav(PluginCall call) {
        boolean previous = call.getBoolean("hasPrevious", false);
        boolean next = call.getBoolean("hasNext", false);
        Boolean like = call.getBoolean("liked");
        boolean seek = call.getBoolean("seekButtons", false);
        mainHandler.post(() -> {
            hasPrevious = previous;
            hasNext = next;
            liked = like;
            seekButtons = seek;
            if (mediaSession != null) QueueSession.setState(getContext(), mediaSession, hasNext, liked, seekButtons);
            call.resolve();
        });
    }

    private void releaseMediaSession() {
        if (mediaSession == null) return;
        PlaybackService.detach(getContext(), mediaSession);
        mediaSession.release();
        mediaSession = null;
    }

    @PluginMethod()
    public void play(PluginCall call) {
        mainHandler.post(() -> { if (player != null) player.play(); call.resolve(); });
    }

    @PluginMethod()
    public void pause(PluginCall call) {
        mainHandler.post(() -> { if (player != null) player.pause(); call.resolve(); });
    }

    /** Re-prepares the current item after a load error, at the same position and without clearing the surface. */
    @PluginMethod()
    public void retry(PluginCall call) {
        mainHandler.post(() -> {
            if (player != null && player.getPlayerError() != null) player.prepare();
            call.resolve();
        });
    }

    @PluginMethod()
    public void seek(PluginCall call) {
        double position = call.getDouble("position", 0.0);
        mainHandler.post(() -> {
            if (player != null) {
                // Drop stale cues before the seek: SubtitleView keeps the last set until onCues fires, and an external VTT can take
                // hundreds of ms after seekTo, reading as shifted subtitles.
                if (subtitles != null) subtitles.clear();
                player.seekTo(Math.round(position * 1000));
            }
            call.resolve();
        });
    }

    @PluginMethod()
    public void stop(PluginCall call) {
        mainHandler.post(() -> {
            stopPositionUpdates();
            if (player != null) player.stop();
            crop = null;
            layoutVideo();
            call.resolve();
        });
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
                            // An override bypasses the support check: forcing it fails decoder init.
                            if (!group.isTrackSupported(i)) {
                                call.reject("Audio track not supported: " + id);
                                return;
                            }
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
                            t.put("forced", (fmt.selectionFlags & C.SELECTION_FLAG_FORCED) != 0);
                            t.put("image", isImageSubtitle(fmt));
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

    // ── Subtitle Style ──

    @PluginMethod()
    public void setSubtitleStyle(PluginCall call) {
        float fontScale = call.getFloat("fontScale", 1.0f);
        String fgColor = call.getString("foregroundColor", "#FFFFFF");
        String bgColor = call.getString("backgroundColor", "transparent");
        String edgeType = call.getString("edgeType", "drop_shadow");
        int bottomMargin = call.getInt("bottomMarginPercent", 10);
        int topMargin = call.getInt("topMarginPercent", 5);

        mainHandler.post(() -> {
            if (subtitles == null) { call.resolve(); return; }

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

            subtitles.applyStyle(style, fontScale, bottomMargin / 100f, topMargin / 100f);

            call.resolve();
        });
    }

    // ── Display ──

    @PluginMethod()
    public void setFillScreen(PluginCall call) {
        boolean fill = call.getBoolean("fill", false);
        mainHandler.post(() -> {
            fillScreen = fill;
            layoutVideo();
            call.resolve();
        });
    }

    /** Crops letterbox bars by sizing aspectFrame past the clipping wrapper.
     *  An absent or non-positive rectangle clears the crop. */
    @PluginMethod()
    public void setCrop(PluginCall call) {
        Double w = call.getDouble("width");
        Double h = call.getDouble("height");
        Double sw = call.getDouble("sourceWidth");
        Double sh = call.getDouble("sourceHeight");
        VideoCropLayout.Crop next = null;
        if (w != null && h != null && sw != null && sh != null && w > 0 && h > 0 && sw > 0 && sh > 0) {
            double x = call.getDouble("x", 0.0);
            double y = call.getDouble("y", 0.0);
            next = new VideoCropLayout.Crop(
                    (float) x, (float) y, w.floatValue(), h.floatValue(), sw.floatValue(), sh.floatValue());
        }
        final VideoCropLayout.Crop finalCrop = next;
        mainHandler.post(() -> {
            crop = finalCrop;
            layoutVideo();
            call.resolve();
        });
    }

    /** No effective crop: MATCH_PARENT, FIT or ZOOM per fillScreen. A crop sizes
     *  aspectFrame to the exact display frame (may overflow the wrapper) and FILLs it. */
    private void layoutVideo() {
        if (aspectFrame == null || wrapper == null) return;
        int containerW = wrapper.getWidth();
        int containerH = wrapper.getHeight();
        int[] frame = containerW > 0 && containerH > 0
                ? VideoCropLayout.frame(containerW, containerH, crop, displayWidth, displayHeight, fillScreen)
                : null;

        FrameLayout.LayoutParams next;
        int resizeMode;
        if (frame != null) {
            // LEFT, not START: the offsets are physical, and START resolves to RIGHT in RTL.
            next = new FrameLayout.LayoutParams(frame[2], frame[3], Gravity.TOP | Gravity.LEFT);
            next.leftMargin = frame[0];
            next.topMargin = frame[1];
            resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FILL;
        } else {
            next = new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.CENTER);
            resizeMode = fillScreen ? AspectRatioFrameLayout.RESIZE_MODE_ZOOM : AspectRatioFrameLayout.RESIZE_MODE_FIT;
        }
        aspectFrame.setResizeMode(resizeMode);

        ViewGroup.LayoutParams current = aspectFrame.getLayoutParams();
        if (!(current instanceof FrameLayout.LayoutParams) || !sameParams((FrameLayout.LayoutParams) current, next)) {
            aspectFrame.setLayoutParams(next);
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
            if (subtitles != null) {
                subtitles.setTextAlpha(brightness >= 1.0f ? 0.5f : 1.0f);
            }

            call.resolve();
        });
    }

    // ── Configuration ──

    private String[] audioLanguages() {
        return preferredAudioLanguage.isEmpty() ? new String[0] : new String[] {preferredAudioLanguage};
    }

    /** Engine knobs sent ahead of load(): the audio the player opens on and the bandwidth its ABR starts from. */
    @PluginMethod()
    public void configure(PluginCall call) {
        String language = call.getString("preferredAudioLanguage");
        Double bandwidth = call.getDouble("defaultBandwidthEstimate");
        mainHandler.post(() -> {
            if (language != null) {
                preferredAudioLanguage = language;
                if (player != null) {
                    player.setTrackSelectionParameters(
                            player.getTrackSelectionParameters().buildUpon()
                                    .setPreferredAudioLanguages(audioLanguages()).build());
                }
            }
            if (bandwidth != null && bandwidth > 0) initialBandwidthBps = Math.round(bandwidth);
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
                // Called before load() built the player (player.ts pins a saved quality to keep the bandwidth probe off the wrong variant):
                // queue the height for onTracksChanged. Resolve, don't reject: the caller doesn't await.
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

            // Soft-cap the max video size first so the initial track selection skips higher variants, which would otherwise
            // cost a wasted ffmpeg session ('Quality change ... killing old session').
            player.setTrackSelectionParameters(
                    player.getTrackSelectionParameters().buildUpon()
                            .setMaxVideoSize(width, height)
                            .build());
            // Then pin the exact variant once known (onTracksChanged): a manual pick, not just a cap,
            // so a 2016-px cinema 4K can't slip in under a 1080p pick.
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
                // Tie-break by bitrate: a remux and a transcode of the same height resolve to the remux, avoiding a redundant FFmpeg session.
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
    public void getQoe(PluginCall call) {
        mainHandler.post(() -> {
            JSObject r = new JSObject();
            r.put("engine", "exoplayer");
            r.put("cmcd", qoeCmcd);
            Long decoded = null, dropped = null, bandwidth = null, bitrate = null;
            Double ahead = null;
            Integer w = null, h = null;
            String codec = null;
            if (player != null) {
                DecoderCounters c = player.getVideoDecoderCounters();
                if (c != null) {
                    c.ensureUpdated();
                    dropped = (long) c.droppedBufferCount;
                    decoded = (long) c.renderedOutputBufferCount + c.skippedOutputBufferCount + c.droppedBufferCount;
                }
                androidx.media3.common.Format f = player.getVideoFormat();
                if (f != null) {
                    int br = f.bitrate != androidx.media3.common.Format.NO_VALUE ? f.bitrate
                            : f.averageBitrate != androidx.media3.common.Format.NO_VALUE ? f.averageBitrate
                            : f.peakBitrate;
                    if (br > 0) bitrate = (long) br;
                    if (f.width > 0) w = f.width;
                    if (f.height > 0) h = f.height;
                    codec = f.codecs != null ? f.codecs : f.sampleMimeType;
                }
                if (qoeBandwidthBps >= 0) bandwidth = qoeBandwidthBps;
                ahead = Math.max(0, player.getBufferedPosition() - player.getCurrentPosition()) / 1000.0;
            }
            r.put("droppedFrames", orNull(dropped));
            r.put("decodedFrames", orNull(decoded));
            r.put("bandwidthBps", orNull(bandwidth));
            r.put("bufferAheadS", orNull(ahead));
            r.put("variantBitrate", orNull(bitrate));
            r.put("width", orNull(w));
            r.put("height", orNull(h));
            r.put("videoCodec", orNull(codec));
            r.put("decoderName", orNull(qoeDecoderName));
            r.put("hwDecoder", orNull(qoeHwDecoder));
            call.resolve(r);
        });
    }

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

        // "text-N" is the Nth text track across all groups, as getSubtitleTracks numbers them.
        int idx = 0;
        for (Tracks.Group group : player.getCurrentTracks().getGroups()) {
            if (group.getType() == C.TRACK_TYPE_TEXT) {
                for (int i = 0; i < group.length; i++) {
                    if (idx == targetIndex) {
                        player.setTrackSelectionParameters(
                                player.getTrackSelectionParameters().buildUpon()
                                        .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                                        .setOverrideForType(
                                                new TrackSelectionOverride(group.getMediaTrackGroup(), i))
                                        .build());
                        return true;
                    }
                    idx++;
                }
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
                    t.put("supported", group.isTrackSupported(i));
                    list.put(t);
                    flatIdx++;
                }
            }
        }
        return list;
    }

    private String lastEmittedState = "";
    private long lastNonBufferingAt = 0;
    private static final long BUFFERING_GUARD_MS = 300;

    private void emitStateChanged(String state) {
        // Hysteresis on BUFFERING: ExoPlayer can oscillate ready/buffering after a seek, so swallow a BUFFERING emit
        // within 300 ms of a playable state.
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
        if (firstFrameSignaled) return;
        firstFrameSignaled = true;
        if (shutter != null) shutter.setVisibility(View.GONE);
        getBridge().getWebView().evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('nativePlayerFirstFrame'));", null);
    }

    private void emitTracksChanged() {
        JSArray audio = buildAudioTrackList();
        // ExoPlayer fires onTracksChanged on every HLS segment transition: emit only a changed list.
        String json = audio.toString();
        if (json.equals(lastAudioTracksJson)) return;
        lastAudioTracksJson = json;
        getBridge().getWebView().evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('nativePlayerTracksChanged',{detail:{audioTracks:" + audio + ",subtitleTracks:[]}}));", null);
    }

    private void emitPosition() {
        if (player == null) return;
        double pos = player.getCurrentPosition() / 1000.0;
        double dur = player.getDuration() != C.TIME_UNSET ? player.getDuration() / 1000.0 : 0;
        double buf = player.getBufferedPosition() / 1000.0;
        getBridge().getWebView().evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('nativePlayerTimeUpdate',{detail:{position:" + pos + ",duration:" + dur + ",buffered:" + buf + "}}));", null);
    }

    private void startPositionUpdates() {
        stopPositionUpdates();
        positionHandler = new Handler(Looper.getMainLooper());
        positionRunnable = new Runnable() {
            @Override public void run() {
                // Emit while the player exists, not only while isPlaying(): NativeEngine's firstFrame fallback needs a second event
                // with a growing position, and isPlaying() is false in STATE_BUFFERING (JS polling was dropped in 9e2269dc).
                emitPosition();
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
