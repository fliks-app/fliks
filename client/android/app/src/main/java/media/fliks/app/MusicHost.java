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
import androidx.media3.common.MimeTypes;
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
import androidx.media3.exoplayer.drm.DrmSessionManagerProvider;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.exoplayer.source.MediaSource;
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy;
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
    private static final long WATCH_MS = 2_000;
    /** A paused queue stays a remote target this long, so another device can resume it. */
    private static final long FACE_LINGER_MS = 5 * 60_000;
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
        /** The server serves an HLS timeline (transcode or remux) rather than the file. */
        final boolean hls;

        Resolved(String path, String sessionId, long mediaFileId, double duration, boolean hls) {
            this.hls = hls;
            this.path = path;
            this.sessionId = sessionId;
            this.mediaFileId = mediaFileId;
            this.duration = duration;
        }
    }

    /** An audiobook's parts: what native progress beats need, as the web layer computes them. */
    static final class Book {
        final long mediaId;
        final long itemId;
        final long mediaFileId;
        final String sessionId;
        final double duration;
        final double[] offsets;

        Book(long mediaId, long itemId, long mediaFileId, String sessionId, double duration, double[] offsets) {
            this.mediaId = mediaId;
            this.itemId = itemId;
            this.mediaFileId = mediaFileId;
            this.sessionId = sessionId;
            this.duration = duration;
            this.offsets = offsets;
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
    /** The activity is resumed: only then is the web layer sure to run its timers. */
    private volatile boolean webForeground;
    private final NativeFace face;
    private long playedAt;
    /** The last remote command applied, which the next beat acknowledges. */
    @Nullable private volatile String lastCmdId;
    /** Server and user the queue started under; a different signed-in session never reaches it. */
    @Nullable private volatile String sessionKey;
    @Nullable private volatile Book book;
    private boolean jsEditing;
    private boolean externalQueue;
    private int lastIndex = -1;
    /** The track whose failed load was retried once; cleared when playback resumes. */
    private int recoveredAt = -1;
    private long lastBeat;
    private String mode;
    private int preamp;
    private double duck = 1;
    private final StemCompanions stems;

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
        DefaultMediaSourceFactory base = new DefaultMediaSourceFactory(context).setDataSourceFactory(source);
        exo = new ExoPlayer.Builder(context, renderers)
                .setMediaSourceFactory(new TrackSourceFactory(base))
                .setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true)
                .setSeekBackIncrementMs(15_000)
                .setSeekForwardIncrementMs(30_000)
                .setHandleAudioBecomingNoisy(true)
                .setWakeMode(C.WAKE_MODE_NETWORK)
                .setLooper(Looper.getMainLooper())
                .build();
        player = new RoutedPlayer(exo);
        face = new NativeFace(context, api, io, main, this::onRemote);
        exo.addListener(new Listener());
        stems = new StemCompanions(context, source, exo, this::applyGain, () -> emit("stems", new JSObject().put("state", "failed")));
    }

    // ---- web layer ----

    void setEmitter(@Nullable Emitter emitter) {
        this.emitter = emitter;
    }

    void setObserved(boolean observed) {
        this.observed = observed;
        if (!observed) player.routed = false;
    }

    void setWebForeground(boolean foreground) {
        webForeground = foreground;
        if (foreground) main.post(watch);
    }

    /** The web layer beats and takes remote commands itself. */
    private boolean webLive() {
        return observed && webForeground;
    }

    /** A WebView exists: it refreshes tokens when native asks, so native never rotates them. */
    void setWebLoaded(boolean loaded) {
        api.setWebOwnsRefresh(loaded, loaded ? () -> main.post(() -> emit("refresh", new JSObject())) : null);
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

    /** Rule 30 of the karaoke spec: stems mixed by two players slaved to `exo`. */
    void setStems(String key, String instrumentalUrl, String vocalsUrl) {
        stems.load(key, instrumentalUrl, vocalsUrl);
    }

    void setStemMix(float mainLevel, float instrumental, float vocals) {
        stems.setMix(new StemCompanions.Mix(mainLevel, instrumental, vocals));
    }

    void clearStems() {
        stems.clear();
    }

    void setRouted(boolean routed) {
        player.routed = routed;
    }

    String absolute(String path) {
        return api.absolute(path);
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
        book = null;
        sessionKey = api.activeKey();
        edit(() -> exo.setMediaItems(items, index, startMs));
        exo.prepare();
        exo.setPlayWhenReady(autoplay);
        PlaybackService.start(context);
        main.removeCallbacks(watch);
        main.post(watch);
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

    void setBook(@Nullable Book book) {
        this.book = book;
    }

    void stop() {
        beat(false);
        face.leave(sessionKey);
        stems.clear();
        edit(() -> {
            exo.stop();
            exo.clearMediaItems();
        });
        stopSessions(null, null);
        sessionKey = null;
        book = null;
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

    /** A music track opens as the file or as the item's HLS stream, whichever the server decides. */
    private final class TrackSourceFactory implements MediaSource.Factory {
        private final MediaSource.Factory base;

        TrackSourceFactory(MediaSource.Factory base) {
            this.base = base;
        }

        @Override
        public MediaSource.Factory setDrmSessionManagerProvider(DrmSessionManagerProvider provider) {
            base.setDrmSessionManagerProvider(provider);
            return this;
        }

        @Override
        public MediaSource.Factory setLoadErrorHandlingPolicy(LoadErrorHandlingPolicy policy) {
            base.setLoadErrorHandlingPolicy(policy);
            return this;
        }

        @Override
        public int[] getSupportedTypes() {
            return base.getSupportedTypes();
        }

        @Override
        public MediaSource createMediaSource(MediaItem item) {
            if (item.localConfiguration == null || !MusicCatalog.SCHEME.equals(item.localConfiguration.uri.getScheme())) {
                return base.createMediaSource(item);
            }
            return new DeferredMediaSource(item, base, this::open, io);
        }

        private MediaItem open(MediaItem item) throws IOException {
            String key = boundKey();
            Resolved r = resolveTrack(Long.parseLong(item.localConfiguration.uri.getHost()), key);
            if (!r.hls) return item;
            return item.buildUpon().setUri(api.streamUrl(r.path, r.sessionId, r.mediaFileId, key))
                    .setMimeType(MimeTypes.APPLICATION_M3U8).build();
        }
    }

    private DataSpec resolve(DataSpec spec) throws IOException {
        if (!MusicCatalog.SCHEME.equals(spec.uri.getScheme())) return spec;
        String key = boundKey();
        Resolved r = resolveTrack(Long.parseLong(spec.uri.getHost()), key);
        return spec.withUri(Uri.parse(api.streamUrl(r.path, r.sessionId, r.mediaFileId, key)));
    }

    /** The session the queue started under, once it is still the signed-in one; otherwise the queue ends. */
    private String boundKey() throws IOException {
        String key = sessionKey;
        if (key == null || !key.equals(api.activeKey())) {
            main.post(this::stop);
            throw new FliksApi.SessionChanged();
        }
        return key;
    }

    private Resolved resolveTrack(long itemId, String key) throws IOException {
        Resolved known = resolved.get(itemId);
        if (known != null) return known;
        String profile = prefs.getString("deviceProfile", null);
        if (profile == null) throw new IOException("no device profile");
        try {
            JSONObject info = api.postJson("/api/items/" + itemId + "/playback-info?startAt=0", profile, key);
            boolean hls = !"DirectPlay".equals(info.optString("playMethod"));
            JSONArray parts = info.optJSONArray("parts");
            String url = !hls && parts != null && parts.length() > 0 ? parts.getJSONObject(0).getString("playUrl")
                    : info.getString("playUrl");
            int q = url.indexOf('?');
            Resolved r = new Resolved(q < 0 ? url : url.substring(0, q), info.optString("sessionId"),
                    info.optLong("mediaFileId"), info.optDouble("durationSeconds", 0), hls);
            resolved.put(itemId, r);
            main.post(this::emitTrack);
            return r;
        } catch (JSONException e) {
            throw new IOException(e);
        }
    }

    private void endSession(String sessionId, String key) {
        if (sessionId.isEmpty()) return;
        try {
            api.send("DELETE", "/api/stream/sessions/" + Uri.encode(sessionId), null, key);
        } catch (IOException ignored) {
            // The server expires an abandoned session.
        }
    }

    private void stopSessions(@Nullable Long keep, @Nullable Long alsoKeep) {
        String key = sessionKey;
        for (Map.Entry<Long, Resolved> e : resolved.entrySet()) {
            if (e.getKey().equals(keep) || e.getKey().equals(alsoKeep)) continue;
            resolved.remove(e.getKey());
            String sid = e.getValue().sessionId;
            if (key != null) io.execute(() -> endSession(sid, key));
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

    /** Beats and remote commands for as long as the web layer cannot: backgrounded (its renderer may be
     *  frozen) or gone. The device is then a remote target of its own (`remote.md` rule 21a). */
    private final Runnable watch = new Runnable() {
        @Override
        public void run() {
            main.removeCallbacks(this);
            if (exo.getMediaItemCount() == 0) return;
            long now = System.currentTimeMillis();
            if (exo.isPlaying()) playedAt = now;
            if (webLive() || now - playedAt > FACE_LINGER_MS) face.leave(sessionKey);
            else if (sessionKey != null) face.poll(sessionKey);
            main.postDelayed(this, WATCH_MS);
        }
    };

    private void onRemote(JSONObject event) {
        String type = event.optString("type");
        if ("session.superseded".equals(type)) {
            stop();
            return;
        }
        if (!"remote.command".equals(type) || event.optLong("expiresAt") < System.currentTimeMillis()) return;
        String action = event.optString("action");
        if (!handles(action, event)) return;
        lastCmdId = event.optString("cmdId", null);
        switch (action) {
            case "play": exo.play(); break;
            case "pause": exo.pause(); break;
            case "playpause": if (exo.isPlaying()) exo.pause(); else exo.play(); break;
            case "stop": stop(); break;
            case "seek": seekTo(event.optDouble("positionSeconds", 0)); break;
            case "next": if (itemOf(exo.getCurrentMediaItem()) == null) exo.seekForward(); else exo.seekToNextMediaItem(); break;
            case "prev": if (itemOf(exo.getCurrentMediaItem()) == null) exo.seekBack(); else exo.seekToPreviousMediaItem(); break;
            case "load":
                if (event.has("positionSeconds")) seekTo(event.optDouble("positionSeconds", 0));
                if (event.optBoolean("paused", false)) exo.pause(); else exo.play();
                break;
            default: break;
        }
        // After the player settled: the beat carries the state the command led to, and acknowledges it.
        if (!"stop".equals(action)) main.postDelayed(() -> beat(exo.isPlaying()), 300);
    }

    /** What the service can do alone, as declared to the server (`NativeFace.ACTIONS`). */
    private boolean handles(String action, JSONObject event) {
        switch (action) {
            case "play": case "pause": case "playpause": case "stop": case "seek": case "next": case "prev":
                return true;
            case "load": {
                // Resuming the file it holds (the server compares files too), a book's parts included.
                long file = event.optLong("mediaFileId", -1);
                return file >= 0 && file == heldFile();
            }
            default:
                return false;
        }
    }

    /** The media file of what the player holds; -1 with nothing loaded. */
    private long heldFile() {
        Book b = book;
        if (b != null) return b.mediaFileId;
        Long item = itemOf(exo.getCurrentMediaItem());
        Resolved r = item == null ? null : resolved.get(item);
        return r == null ? -1 : r.mediaFileId;
    }

    /** `position` is in the track, or in the whole book for parts. */
    private void seekTo(double position) {
        Book b = book;
        int part = 0;
        if (b != null) {
            while (part + 1 < b.offsets.length && b.offsets[part + 1] <= position) part++;
            exo.seekTo(part, (long) ((position - b.offsets[part]) * 1000));
        } else {
            exo.seekTo(exo.getCurrentMediaItemIndex(), (long) (position * 1000));
        }
    }

    /** Progress to the server for what the web layer does not take care of. */
    private void beat(boolean playing) {
        lastBeat = System.currentTimeMillis();
        MediaItem current = exo.getCurrentMediaItem();
        if (webLive() || current == null) return;
        face.want();
        Book b = book;
        Long item = itemOf(current);
        Resolved r = item == null ? null : resolved.get(item);
        if (b == null && r == null) return;
        String key = sessionKey;
        if (key == null || !key.equals(api.activeKey())) {
            main.post(this::stop);
            return;
        }
        long d = exo.getDuration();
        double position = exo.getCurrentPosition() / 1000.0;
        try {
            JSONObject body = new JSONObject().put("state", playing ? "playing" : "paused");
            String target = face.targetId();
            if (target != null) body.put("targetId", target);
            long media;
            if (b != null) {
                int i = exo.getCurrentMediaItemIndex();
                media = b.mediaId;
                body.put("positionSeconds", (i < b.offsets.length ? b.offsets[i] : 0) + position)
                        .put("durationSeconds", b.duration).put("mediaFileId", b.mediaFileId)
                        .put("itemId", b.itemId).put("sessionId", b.sessionId);
            } else {
                media = current.mediaMetadata.extras.getLong(MusicCatalog.X_MEDIA);
                body.put("positionSeconds", position)
                        .put("durationSeconds", d == C.TIME_UNSET ? r.duration : d / 1000.0)
                        .put("mediaFileId", r.mediaFileId).put("itemId", item).put("sessionId", r.sessionId);
            }
            String ack = lastCmdId;
            if (ack != null) body.put("lastCmdId", ack);
            String payload = body.toString();
            io.execute(() -> {
                try {
                    face.ensure(key);
                } catch (IOException ignored) {
                    // The beat does not depend on the registration: an older server refuses `actions`.
                }
                try {
                    api.send("PUT", "/api/playback/media/" + media + "/state", payload, key);
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
        gain.setFactor((float) (factor * duck) * stems.mainLevel());
        stems.setVolumes((float) (factor * duck));
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
            if (stems.active()) {
                stems.clear();
                emit("stems", new JSObject().put("state", "cleared"));
            }
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
            playedAt = System.currentTimeMillis();
            if (playing) {
                recoveredAt = -1;
                main.post(tick);
                main.post(watch);
                beat(true);
            } else beat(false);
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
            int index = exo.getCurrentMediaItemIndex();
            if (recoveredAt != index) {
                recoveredAt = index;
                exo.prepare();
                return;
            }
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

        boolean routing() {
            return routed && observed;
        }

        private boolean route(String command, double value) {
            if (!routing()) return false;
            JSObject o = new JSObject();
            o.put("command", command);
            o.put("value", value);
            emit("command", o);
            return true;
        }

        /** A party has one current track: a jump to another queue entry has no intent, so it is dropped. */
        private boolean routeSeek(int index, long ms) {
            if (!routing()) return false;
            if (index == getCurrentMediaItemIndex()) route("seek", ms == C.TIME_UNSET ? 0 : ms / 1000.0);
            return true;
        }

        @Override public void play() { if (!route("play", 0)) super.play(); }
        @Override public void pause() { if (!route("pause", 0)) super.pause(); }
        /** Audiobook parts have no tracks to skip: next and previous step like the skip buttons. */
        private boolean isBook() {
            return itemOf(getCurrentMediaItem()) == null;
        }

        @Override public void seekToNext() { if (isBook()) seekForward(); else if (!route("next", 0)) super.seekToNext(); }
        @Override public void seekToNextMediaItem() { if (isBook()) seekForward(); else if (!route("next", 0)) super.seekToNextMediaItem(); }
        @Override public void seekToPrevious() { if (isBook()) seekBack(); else if (!route("previous", 0)) super.seekToPrevious(); }
        @Override public void seekToPreviousMediaItem() { if (isBook()) seekBack(); else if (!route("previous", 0)) super.seekToPreviousMediaItem(); }
        @Override public void seekTo(long ms) { if (!routeSeek(getCurrentMediaItemIndex(), ms)) super.seekTo(ms); }
        @Override public void seekTo(int index, long ms) { if (!routeSeek(index, ms)) super.seekTo(index, ms); }
        @Override public void seekToDefaultPosition() { if (!routeSeek(getCurrentMediaItemIndex(), C.TIME_UNSET)) super.seekToDefaultPosition(); }
        @Override public void seekToDefaultPosition(int index) { if (!routeSeek(index, C.TIME_UNSET)) super.seekToDefaultPosition(index); }
        @Override public void seekBack() {
            if (!routeSeek(getCurrentMediaItemIndex(), Math.max(0, getCurrentPosition() - getSeekBackIncrement()))) super.seekBack();
        }
        @Override public void seekForward() {
            if (!routeSeek(getCurrentMediaItemIndex(), getCurrentPosition() + getSeekForwardIncrement())) super.seekForward();
        }
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
            if (player.routing() || !bindSession()) return refused();
            return Futures.transform(expandAll(items), q -> q.items, io);
        }

        @Override
        public ListenableFuture<MediaSession.MediaItemsWithStartPosition> onSetMediaItems(
                MediaSession s, MediaSession.ControllerInfo c, List<MediaItem> items, int startIndex, long startPositionMs) {
            if (player.routing()) return refused();
            sessionKey = api.activeKey();
            externalQueue = true;
            return Futures.transform(expandAll(items), q -> new MediaSession.MediaItemsWithStartPosition(
                    q.items, items.size() == 1 ? q.start : startIndex, startPositionMs), io);
        }

        private <T> ListenableFuture<T> refused() {
            return Futures.immediateFailedFuture(new UnsupportedOperationException("a party drives the audio"));
        }

        /** An empty queue takes the signed-in session; a queue of another session takes nothing. */
        private boolean bindSession() {
            String key = sessionKey;
            if (key == null) {
                sessionKey = api.activeKey();
                return sessionKey != null;
            }
            return key.equals(api.activeKey());
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
