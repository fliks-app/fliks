package media.fliks.app;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;

import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.ForwardingPlayer;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.common.Player;
import androidx.media3.common.Timeline;
import androidx.media3.common.audio.AudioProcessor;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DataSpec;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.ResolvingDataSource;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.audio.AudioSink;
import androidx.media3.exoplayer.audio.DefaultAudioSink;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.session.LibraryResult;
import androidx.media3.session.MediaLibraryService;
import androidx.media3.session.MediaSession;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.google.common.collect.ImmutableList;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.common.util.concurrent.SettableFuture;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** The native audio player (music queue, audiobook parts) with its library session for Android Auto;
 *  it outlives the WebView, and beats progress itself while no web layer observes it. */
@OptIn(markerClass = UnstableApi.class)
final class MusicHost {
    private static final long TICK_MS = 500;
    private static final long BEAT_MS = 15_000;
    private static final String PREFS = "fliks_audio";

    interface Emitter {
        void emit(String event, JSObject data);
    }

    /** What a track's playback-info call returned. */
    private static final class Resolved {
        final String path;
        final String sessionId;
        final long mediaFileId;
        final double duration;

        Resolved(String path, String sessionId, long mediaFileId, double duration) {
            this.path = path;
            this.sessionId = sessionId;
            this.mediaFileId = mediaFileId;
            this.duration = duration;
        }
    }

    private static MusicHost instance;

    static synchronized MusicHost get(Context context) {
        if (instance == null) instance = new MusicHost(context.getApplicationContext());
        return instance;
    }

    /** True while the player holds a queue: the service stays up for it. */
    static boolean loaded() {
        return instance != null && instance.exo.getMediaItemCount() > 0;
    }

    private final Context context;
    private final SharedPreferences prefs;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newCachedThreadPool();
    private final AudioGainProcessor gain = new AudioGainProcessor();
    private final FliksApi api;
    private final MusicCatalog catalog;
    private final ExoPlayer exo;
    private final RoutedPlayer player;
    private final Map<Long, Resolved> resolved = new ConcurrentHashMap<>();
    private final Map<String, List<MediaItem>> searches = new ConcurrentHashMap<>();

    @Nullable private Emitter emitter;
    @Nullable private MediaLibraryService.MediaLibrarySession session;
    private volatile boolean observed;
    private boolean jsEditing;
    private boolean externalQueue;
    private int lastIndex = -1;
    private long lastBeat;
    private String mode;
    private int preamp;
    private double duck = 1;

    private MusicHost(Context context) {
        this.context = context;
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        mode = prefs.getString("replayGain", "track");
        preamp = prefs.getInt("preamp", 0);
        api = new FliksApi(context);
        catalog = new MusicCatalog(context, api);
        DefaultRenderersFactory renderers = new DefaultRenderersFactory(context) {
            @Override
            protected AudioSink buildAudioSink(Context c, boolean enableFloat, boolean enableParams) {
                return new DefaultAudioSink.Builder(c)
                        .setEnableFloatOutput(enableFloat)
                        .setEnableAudioTrackPlaybackParams(enableParams)
                        .setAudioProcessors(new AudioProcessor[]{gain})
                        .build();
            }
        };
        DataSource.Factory http = new DefaultHttpDataSource.Factory().setAllowCrossProtocolRedirects(true);
        DataSource.Factory source = new ResolvingDataSource.Factory(new DefaultDataSource.Factory(context, http), this::resolve);
        exo = new ExoPlayer.Builder(context, renderers)
                .setMediaSourceFactory(new DefaultMediaSourceFactory(context).setDataSourceFactory(source))
                .setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true)
                .setHandleAudioBecomingNoisy(true)
                .setWakeMode(C.WAKE_MODE_NETWORK)
                .setLooper(Looper.getMainLooper())
                .build();
        player = new RoutedPlayer(exo);
        exo.addListener(new Listener());
    }

    // ---- web layer ----

    void setEmitter(@Nullable Emitter emitter) {
        this.emitter = emitter;
    }

    void setObserved(boolean observed) {
        this.observed = observed;
        api.setWebOwnsRefresh(observed);
        if (!observed) player.routed = false;
    }

    void setDeviceProfile(String profile) {
        prefs.edit().putString("deviceProfile", profile).apply();
    }

    void setGain(String mode, int preamp, double duck) {
        this.mode = mode;
        this.preamp = preamp;
        this.duck = duck;
        prefs.edit().putString("replayGain", mode).putInt("preamp", preamp).apply();
        applyGain();
    }

    void setRouted(boolean routed) {
        player.routed = routed;
    }

    String absolute(String path) {
        return api.absolute(path, true);
    }

    ExoPlayer exo() {
        return exo;
    }

    void edit(Runnable r) {
        jsEditing = true;
        try {
            r.run();
        } finally {
            jsEditing = false;
        }
    }

    void setQueue(List<MediaItem> items, int index, long startMs, boolean autoplay) {
        lastIndex = -1;
        edit(() -> exo.setMediaItems(items, index, startMs));
        exo.prepare();
        exo.setPlayWhenReady(autoplay);
        PlaybackService.start(context);
    }

    /** Replaces the order around the current entry, which the web layer keeps at `index`. */
    void updateQueue(List<MediaItem> items, int index) {
        int cur = exo.getCurrentMediaItemIndex();
        if (cur < 0 || cur >= exo.getMediaItemCount() || index >= items.size()
                || !exo.getCurrentMediaItem().mediaId.equals(items.get(index).mediaId)) {
            setQueue(items, index, C.TIME_UNSET, exo.getPlayWhenReady());
            return;
        }
        edit(() -> {
            exo.removeMediaItems(cur + 1, exo.getMediaItemCount());
            exo.addMediaItems(items.subList(index + 1, items.size()));
            exo.removeMediaItems(0, cur);
            exo.addMediaItems(0, items.subList(0, index));
        });
        applyGain();
    }

    void stop() {
        beat(false);
        edit(() -> {
            exo.stop();
            exo.clearMediaItems();
        });
        stopSessions(null, null);
        lastIndex = -1;
        PlaybackService.musicStopped(context);
    }

    // ---- library session ----

    MediaLibraryService.MediaLibrarySession createSession(MediaLibraryService service) {
        Intent open = new Intent(service, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        session = new MediaLibraryService.MediaLibrarySession.Builder(service, player, new LibraryCallback())
                .setId(PlaybackService.MUSIC_SESSION_ID)
                .setSessionActivity(PendingIntent.getActivity(service, 0, open, PendingIntent.FLAG_IMMUTABLE))
                .build();
        return session;
    }

    void releaseSession() {
        if (session != null) session.release();
        session = null;
    }

    // ---- streams ----

    private DataSpec resolve(DataSpec spec) throws IOException {
        if (!MusicCatalog.SCHEME.equals(spec.uri.getScheme())) return spec;
        Resolved r = resolveTrack(Long.parseLong(spec.uri.getHost()));
        return spec.withUri(Uri.parse(api.absolute(r.path + "?sid=" + Uri.encode(r.sessionId), true)));
    }

    private Resolved resolveTrack(long itemId) throws IOException {
        Resolved known = resolved.get(itemId);
        if (known != null) return known;
        String profile = prefs.getString("deviceProfile", null);
        if (profile == null) throw new IOException("no device profile");
        try {
            JSONObject info = api.postJson("/api/items/" + itemId + "/playback-info?startAt=0", profile);
            if (!"DirectPlay".equals(info.optString("playMethod"))) throw new IOException("audio needs a transcode");
            JSONArray parts = info.optJSONArray("parts");
            String url = parts != null && parts.length() > 0 ? parts.getJSONObject(0).getString("playUrl")
                    : info.getString("playUrl");
            int q = url.indexOf('?');
            Resolved r = new Resolved(q < 0 ? url : url.substring(0, q), info.optString("sessionId"),
                    info.optLong("mediaFileId"), info.optDouble("durationSeconds", 0));
            resolved.put(itemId, r);
            main.post(this::emitTrack);
            return r;
        } catch (JSONException e) {
            throw new IOException(e);
        }
    }

    private void stopSessions(@Nullable Long keep, @Nullable Long alsoKeep) {
        for (Map.Entry<Long, Resolved> e : resolved.entrySet()) {
            if (e.getKey().equals(keep) || e.getKey().equals(alsoKeep)) continue;
            resolved.remove(e.getKey());
            String sid = e.getValue().sessionId;
            if (!sid.isEmpty()) io.execute(() -> {
                try {
                    api.send("DELETE", "/api/stream/sessions/" + Uri.encode(sid), null);
                } catch (IOException ignored) {
                    // The server expires an abandoned session.
                }
            });
        }
    }

    // ---- events ----

    private void emit(String event, JSObject data) {
        if (emitter != null) emitter.emit(event, data);
    }

    @Nullable
    private static Long itemOf(@Nullable MediaItem item) {
        Bundle x = item == null ? null : item.mediaMetadata.extras;
        return x != null && x.containsKey(MusicCatalog.X_ITEM) ? x.getLong(MusicCatalog.X_ITEM) : null;
    }

    private void emitTrack() {
        JSObject o = new JSObject();
        o.put("index", exo.getCurrentMediaItemIndex());
        Long item = itemOf(exo.getCurrentMediaItem());
        Resolved r = item == null ? null : resolved.get(item);
        if (item != null) o.put("itemId", item);
        if (r != null) {
            o.put("mediaFileId", r.mediaFileId);
            o.put("sessionId", r.sessionId);
        }
        emit("track", o);
    }

    private void emitState() {
        JSObject o = new JSObject();
        int s = exo.getPlaybackState();
        o.put("playing", exo.isPlaying());
        o.put("playWhenReady", exo.getPlayWhenReady());
        o.put("buffering", s == Player.STATE_BUFFERING);
        o.put("ready", s == Player.STATE_READY);
        o.put("ended", s == Player.STATE_ENDED);
        emit("state", o);
    }

    private void emitPosition() {
        JSObject o = new JSObject();
        o.put("index", exo.getCurrentMediaItemIndex());
        o.put("position", exo.getCurrentPosition() / 1000.0);
        long d = exo.getDuration();
        o.put("duration", d == C.TIME_UNSET ? 0 : d / 1000.0);
        emit("position", o);
    }

    /** Hands the web layer what is playing when it attaches after the player started. */
    void snapshot() {
        if (exo.getMediaItemCount() == 0) return;
        emitQueue();
        emitTrack();
        emitState();
    }

    private void emitQueue() {
        JSArray tracks = new JSArray();
        for (int i = 0; i < exo.getMediaItemCount(); i++) {
            MediaItem m = exo.getMediaItemAt(i);
            Bundle x = m.mediaMetadata.extras;
            if (x == null || !x.containsKey(MusicCatalog.X_ITEM)) continue;
            JSObject t = new JSObject();
            t.put("itemId", x.getLong(MusicCatalog.X_ITEM));
            t.put("mediaId", x.getLong(MusicCatalog.X_MEDIA));
            t.put("title", String.valueOf(m.mediaMetadata.title));
            t.put("artists", String.valueOf(m.mediaMetadata.artist));
            t.put("albumTitle", String.valueOf(m.mediaMetadata.albumTitle));
            t.put("coverUrl", m.mediaMetadata.artworkUri == null ? null : m.mediaMetadata.artworkUri.toString());
            t.put("durationSeconds", m.mediaMetadata.durationMs == null ? null : m.mediaMetadata.durationMs / 1000.0);
            for (String k : new String[]{MusicCatalog.X_GAIN, MusicCatalog.X_PEAK, MusicCatalog.X_ALBUM_GAIN, MusicCatalog.X_ALBUM_PEAK}) {
                double v = x.getDouble(k, Double.NaN);
                t.put(k.substring(6), Double.isNaN(v) ? null : v);
            }
            tracks.put(t);
        }
        JSObject o = new JSObject();
        o.put("tracks", tracks);
        o.put("index", exo.getCurrentMediaItemIndex());
        emit("queue", o);
    }

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            if (!exo.isPlaying()) return;
            emitPosition();
            long now = System.currentTimeMillis();
            if (now - lastBeat >= BEAT_MS) beat(true);
            main.postDelayed(this, TICK_MS);
        }
    };

    /** Progress to the server for a track the web layer does not observe. */
    private void beat(boolean playing) {
        lastBeat = System.currentTimeMillis();
        Long item = observed ? null : itemOf(exo.getCurrentMediaItem());
        Resolved r = item == null ? null : resolved.get(item);
        if (r == null) return;
        long media = exo.getCurrentMediaItem().mediaMetadata.extras.getLong(MusicCatalog.X_MEDIA);
        long d = exo.getDuration();
        try {
            String body = new JSONObject()
                    .put("positionSeconds", exo.getCurrentPosition() / 1000.0)
                    .put("durationSeconds", d == C.TIME_UNSET ? r.duration : d / 1000.0)
                    .put("mediaFileId", r.mediaFileId)
                    .put("itemId", item)
                    .put("sessionId", r.sessionId)
                    .put("state", playing ? "playing" : "paused").toString();
            io.execute(() -> {
                try {
                    api.send("PUT", "/api/playback/media/" + media + "/state", body);
                } catch (IOException ignored) {
                    // The next beat carries the position.
                }
            });
        } catch (JSONException ignored) {
            // Built from numbers and strings.
        }
    }

    // ---- gain ----

    private void applyGain() {
        MediaItem cur = exo.getCurrentMediaItem();
        Bundle x = cur == null ? null : cur.mediaMetadata.extras;
        float factor = 1f;
        if (x != null && !"off".equals(mode)) {
            boolean album = "album".equals(mode) && singleAlbum() && !Double.isNaN(x.getDouble(MusicCatalog.X_ALBUM_GAIN, Double.NaN));
            double g = x.getDouble(album ? MusicCatalog.X_ALBUM_GAIN : MusicCatalog.X_GAIN, Double.NaN);
            double peak = x.getDouble(album ? MusicCatalog.X_ALBUM_PEAK : MusicCatalog.X_PEAK, Double.NaN);
            if (!Double.isNaN(g)) {
                double f = Math.pow(10, (g + preamp) / 20);
                factor = (float) (peak > 0 && f * peak > 1 ? 1 / peak : f);
            }
        }
        gain.setFactor((float) (factor * duck));
    }

    private boolean singleAlbum() {
        long first = -1;
        for (int i = 0; i < exo.getMediaItemCount(); i++) {
            Bundle x = exo.getMediaItemAt(i).mediaMetadata.extras;
            long m = x == null ? -1 : x.getLong(MusicCatalog.X_MEDIA, -1);
            if (first < 0) first = m;
            else if (m != first) return false;
        }
        return first >= 0;
    }

    private final class Listener implements Player.Listener {
        @Override
        public void onMediaItemTransition(@Nullable MediaItem item, int reason) {
            applyGain();
            int index = exo.getCurrentMediaItemIndex();
            if (index != lastIndex) {
                beat(false);
                lastIndex = index;
                // The next track resolves ahead of its turn: its session stays.
                Long next = exo.hasNextMediaItem() ? itemOf(exo.getMediaItemAt(exo.getNextMediaItemIndex())) : null;
                stopSessions(itemOf(item), next);
                emitTrack();
            }
        }

        @Override
        public void onTimelineChanged(Timeline timeline, int reason) {
            if (reason == Player.TIMELINE_CHANGE_REASON_PLAYLIST_CHANGED && !jsEditing && externalQueue) {
                externalQueue = false;
                emitQueue();
            }
            if (timeline.isEmpty()) PlaybackService.musicStopped(context);
        }

        @Override
        public void onIsPlayingChanged(boolean playing) {
            main.removeCallbacks(tick);
            if (playing) main.post(tick);
            else beat(false);
            emitState();
        }

        @Override
        public void onPlaybackStateChanged(int state) {
            emitState();
            if (state == Player.STATE_ENDED) emitPosition();
        }

        @Override
        public void onPlayWhenReadyChanged(boolean playWhenReady, int reason) {
            emitState();
        }

        @Override
        public void onPlayerError(PlaybackException error) {
            JSObject o = new JSObject();
            o.put("message", String.valueOf(error.getMessage()));
            emit("error", o);
        }
    }

    /** What a controller (Auto, notification, headset) does goes to the web layer while a
     *  party drives the audio, which sends it as an intent to the server. */
    private final class RoutedPlayer extends ForwardingPlayer {
        volatile boolean routed;

        RoutedPlayer(Player p) {
            super(p);
        }

        private boolean route(String command, double value) {
            if (!routed || !observed) return false;
            JSObject o = new JSObject();
            o.put("command", command);
            o.put("value", value);
            emit("command", o);
            return true;
        }

        @Override public void play() { if (!route("play", 0)) super.play(); }
        @Override public void pause() { if (!route("pause", 0)) super.pause(); }
        @Override public void seekToNext() { if (!route("next", 0)) super.seekToNext(); }
        @Override public void seekToNextMediaItem() { if (!route("next", 0)) super.seekToNextMediaItem(); }
        @Override public void seekToPrevious() { if (!route("previous", 0)) super.seekToPrevious(); }
        @Override public void seekToPreviousMediaItem() { if (!route("previous", 0)) super.seekToPreviousMediaItem(); }
        @Override public void seekTo(long ms) { if (!route("seek", ms / 1000.0)) super.seekTo(ms); }
        @Override public void seekTo(int index, long ms) { if (!route("seek", ms / 1000.0)) super.seekTo(index, ms); }
    }

    private final class LibraryCallback implements MediaLibraryService.MediaLibrarySession.Callback {
        private <T> ListenableFuture<LibraryResult<T>> async(Work<T> work) {
            SettableFuture<LibraryResult<T>> f = SettableFuture.create();
            io.execute(() -> {
                try {
                    if (!api.signedIn()) {
                        f.set(LibraryResult.ofError(LibraryResult.RESULT_ERROR_SESSION_AUTHENTICATION_EXPIRED));
                        return;
                    }
                    f.set(work.run());
                } catch (FliksApi.HttpError e) {
                    f.set(LibraryResult.ofError(e.status == 401
                            ? LibraryResult.RESULT_ERROR_SESSION_AUTHENTICATION_EXPIRED
                            : LibraryResult.RESULT_ERROR_UNKNOWN));
                } catch (IOException | JSONException | RuntimeException e) {
                    f.set(LibraryResult.ofError(LibraryResult.RESULT_ERROR_IO));
                }
            });
            return f;
        }

        @Override
        public ListenableFuture<LibraryResult<MediaItem>> onGetLibraryRoot(
                MediaLibraryService.MediaLibrarySession s, MediaSession.ControllerInfo c,
                @Nullable MediaLibraryService.LibraryParams params) {
            return Futures.immediateFuture(LibraryResult.ofItem(catalog.root(), params));
        }

        @Override
        public ListenableFuture<LibraryResult<MediaItem>> onGetItem(
                MediaLibraryService.MediaLibrarySession s, MediaSession.ControllerInfo c, String mediaId) {
            return async(() -> {
                MediaItem item = catalog.item(mediaId);
                return item == null ? LibraryResult.ofError(LibraryResult.RESULT_ERROR_BAD_VALUE) : LibraryResult.ofItem(item, null);
            });
        }

        @Override
        public ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> onGetChildren(
                MediaLibraryService.MediaLibrarySession s, MediaSession.ControllerInfo c, String parentId,
                int page, int pageSize, @Nullable MediaLibraryService.LibraryParams params) {
            return async(() -> LibraryResult.ofItemList(ImmutableList.copyOf(catalog.children(parentId, page, pageSize)), params));
        }

        @Override
        public ListenableFuture<LibraryResult<Void>> onSearch(
                MediaLibraryService.MediaLibrarySession s, MediaSession.ControllerInfo c, String query,
                @Nullable MediaLibraryService.LibraryParams params) {
            return async(() -> {
                List<MediaItem> found = catalog.search(query);
                searches.put(query, found);
                s.notifySearchResultChanged(c, query, found.size(), params);
                return LibraryResult.ofVoid();
            });
        }

        @Override
        public ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> onGetSearchResult(
                MediaLibraryService.MediaLibrarySession s, MediaSession.ControllerInfo c, String query,
                int page, int pageSize, @Nullable MediaLibraryService.LibraryParams params) {
            return async(() -> {
                List<MediaItem> found = searches.get(query);
                if (found == null) found = catalog.search(query);
                int from = Math.min(page * pageSize, found.size());
                return LibraryResult.ofItemList(ImmutableList.copyOf(found.subList(from, Math.min(from + pageSize, found.size()))), params);
            });
        }

        @Override
        public ListenableFuture<List<MediaItem>> onAddMediaItems(
                MediaSession s, MediaSession.ControllerInfo c, List<MediaItem> items) {
            return Futures.transform(expandAll(items), q -> q.items, io);
        }

        @Override
        public ListenableFuture<MediaSession.MediaItemsWithStartPosition> onSetMediaItems(
                MediaSession s, MediaSession.ControllerInfo c, List<MediaItem> items, int startIndex, long startPositionMs) {
            externalQueue = true;
            return Futures.transform(expandAll(items), q -> new MediaSession.MediaItemsWithStartPosition(
                    q.items, items.size() == 1 ? q.start : startIndex, startPositionMs), io);
        }

        private ListenableFuture<MusicCatalog.Queue> expandAll(List<MediaItem> items) {
            SettableFuture<MusicCatalog.Queue> f = SettableFuture.create();
            io.execute(() -> {
                try {
                    List<MediaItem> out = new ArrayList<>();
                    int start = 0;
                    for (MediaItem item : items) {
                        if (item.localConfiguration != null) {
                            out.add(item);
                            continue;
                        }
                        MusicCatalog.Queue q = catalog.expand(item.mediaId);
                        if (items.size() == 1) start = q.start;
                        out.addAll(q.items);
                    }
                    f.set(new MusicCatalog.Queue(out, start));
                } catch (IOException | JSONException | RuntimeException e) {
                    f.setException(e);
                }
            });
            return f;
        }
    }

    private interface Work<T> {
        LibraryResult<T> run() throws IOException, JSONException;
    }
}
