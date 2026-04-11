package com.fliks.app;

import android.graphics.Color;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.TextureView;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import androidx.annotation.NonNull;
import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.TrackGroup;
import androidx.media3.common.TrackSelectionOverride;
import androidx.media3.common.Tracks;
import androidx.media3.common.VideoSize;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.hls.HlsMediaSource;
import androidx.media3.ui.AspectRatioFrameLayout;

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
    private TextureView textureView;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private Handler positionHandler;
    private Runnable positionRunnable;

    // ── Lifecycle ──

    @PluginMethod()
    public void create(PluginCall call) {
        mainHandler.post(() -> {
            if (textureView != null) {
                call.resolve();
                return;
            }

            // Black wrapper covers letterbox areas
            wrapper = new FrameLayout(getContext());
            wrapper.setBackgroundColor(Color.BLACK);

            // AspectRatioFrameLayout maintains video aspect ratio
            aspectFrame = new AspectRatioFrameLayout(getContext());
            aspectFrame.setResizeMode(AspectRatioFrameLayout.RESIZE_MODE_FIT);

            textureView = new TextureView(getContext());
            aspectFrame.addView(textureView, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT));

            wrapper.addView(aspectFrame, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    Gravity.CENTER));

            // Insert behind the WebView
            android.webkit.WebView webView = getBridge().getWebView();
            ViewGroup webViewParent = (ViewGroup) webView.getParent();
            webViewParent.addView(wrapper, 0, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT));

            // Transparent WebView so native player shows through
            webView.setBackgroundColor(Color.TRANSPARENT);
            webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);

            call.resolve();
        });
    }

    @PluginMethod()
    public void destroy(PluginCall call) {
        mainHandler.post(() -> {
            stopPositionUpdates();
            if (player != null) {
                player.release();
                player = null;
            }
            if (wrapper != null) {
                ViewGroup parent = (ViewGroup) wrapper.getParent();
                if (parent != null) parent.removeView(wrapper);
                wrapper = null;
                aspectFrame = null;
                textureView = null;
            }
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

            DefaultHttpDataSource.Factory httpFactory = new DefaultHttpDataSource.Factory()
                    .setDefaultRequestProperties(headerMap)
                    .setConnectTimeoutMs(15_000)
                    .setReadTimeoutMs(30_000)
                    .setAllowCrossProtocolRedirects(true);

            HlsMediaSource hlsSource = new HlsMediaSource.Factory(httpFactory)
                    .setAllowChunklessPreparation(true)
                    .createMediaSource(MediaItem.fromUri(Uri.parse(url)));

            player = new ExoPlayer.Builder(getContext())
                    .setWakeMode(C.WAKE_MODE_NETWORK)
                    .build();
            if (textureView != null) player.setVideoTextureView(textureView);

            player.addListener(new Player.Listener() {
                @Override
                public void onPlaybackStateChanged(int state) {
                    switch (state) {
                        case Player.STATE_BUFFERING: emitStateChanged("buffering"); break;
                        case Player.STATE_READY: emitStateChanged(player.getPlayWhenReady() ? "playing" : "paused"); break;
                        case Player.STATE_ENDED: emitStateChanged("ended"); break;
                        default: emitStateChanged("idle");
                    }
                }

                @Override public void onIsPlayingChanged(boolean isPlaying) {
                    emitStateChanged(isPlaying ? "playing" : "paused");
                }

                @Override public void onPlayerError(@NonNull PlaybackException error) {
                    emitError(error.errorCode, error.getMessage());
                }

                @Override public void onTracksChanged(@NonNull Tracks tracks) {
                    emitTracksChanged();
                }

                @Override public void onVideoSizeChanged(@NonNull VideoSize videoSize) {
                    if (aspectFrame != null && videoSize.width > 0 && videoSize.height > 0) {
                        aspectFrame.setAspectRatio(
                                videoSize.width * videoSize.pixelWidthHeightRatio / videoSize.height);
                    }
                }
            });

            player.setMediaSource(hlsSource);
            player.prepare();
            if (startTime > 0) player.seekTo((long) (startTime * 1000));
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
        mainHandler.post(() -> { if (player != null) player.seekTo((long) (position * 1000)); call.resolve(); });
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
                player.setTrackSelectionParameters(
                        player.getTrackSelectionParameters().buildUpon()
                                .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true).build());
                call.resolve();
                return;
            }

            int targetIndex;
            try { targetIndex = Integer.parseInt(id.replace("text-", "")); }
            catch (NumberFormatException e) { call.reject("Invalid track id"); return; }

            int idx = 0;
            for (Tracks.Group group : player.getCurrentTracks().getGroups()) {
                if (group.getType() == C.TRACK_TYPE_TEXT) {
                    if (idx == targetIndex) {
                        player.setTrackSelectionParameters(
                                player.getTrackSelectionParameters().buildUpon()
                                        .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                                        .setOverrideForType(new TrackSelectionOverride(group.getMediaTrackGroup(), 0))
                                        .build());
                        call.resolve();
                        return;
                    }
                    idx++;
                }
            }
            call.reject("Subtitle track not found");
        });
    }

    @PluginMethod()
    public void addExternalSubtitle(PluginCall call) {
        // Stub — external subtitles via MergingMediaSource is a future enhancement
        call.resolve(new JSObject().put("id", "ext-sub-" + System.currentTimeMillis()));
    }

    // ── Quality ──

    @PluginMethod()
    public void setMaxResolution(PluginCall call) {
        int width = call.getInt("width", 0);
        int height = call.getInt("height", 0);
        mainHandler.post(() -> {
            if (player == null) { call.reject("Player not initialized"); return; }
            var builder = player.getTrackSelectionParameters().buildUpon();
            if (width <= 0 || height <= 0) {
                // Auto: remove resolution constraints
                builder.setMaxVideoSize(Integer.MAX_VALUE, Integer.MAX_VALUE);
            } else {
                builder.setMaxVideoSize(width, height);
            }
            player.setTrackSelectionParameters(builder.build());
            call.resolve();
        });
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
                    t.put("language", fmt.language != null ? fmt.language : "und");
                    t.put("label", fmt.label != null ? fmt.label
                            : (fmt.language != null ? fmt.language : "Track " + flatIdx));
                    list.put(t);
                    flatIdx++;
                }
            }
        }
        return list;
    }

    private void emitStateChanged(String state) {
        getBridge().getWebView().evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('nativePlayerStateChanged',{detail:{state:'" + state + "'}}));", null);
    }

    private void emitError(int code, String message) {
        String safe = message != null ? message.replace("'", "\\'") : "Unknown error";
        getBridge().getWebView().evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('nativePlayerError',{detail:{code:" + code + ",message:'" + safe + "'}}));", null);
    }

    private void emitTracksChanged() {
        JSArray audio = buildAudioTrackList();
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
