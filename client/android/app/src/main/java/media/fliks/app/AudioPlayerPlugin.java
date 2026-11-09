package media.fliks.app;

import android.os.Handler;
import android.os.Looper;

import androidx.annotation.Nullable;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.common.Player;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** The bridge of the audio player (music queue and audiobook parts) to the native player. */
@CapacitorPlugin(name = "AudioPlayer")
public class AudioPlayerPlugin extends Plugin {
    private static final String CAPACITOR_FILE = "https://localhost/_capacitor_file_/";

    private final Handler main = new Handler(Looper.getMainLooper());
    private MusicHost host;

    @Override
    public void load() {
        host = MusicHost.get(getContext());
        host.setEmitter((event, data) -> notifyListeners(event, data));
        host.setWebLoaded(true);
    }

    @Override
    protected void handleOnDestroy() {
        host.setEmitter(null);
        host.setObserved(false);
        host.setWebLoaded(false);
    }

    private void run(PluginCall call, Runnable r) {
        main.post(() -> {
            try {
                r.run();
                call.resolve();
            } catch (RuntimeException e) {
                call.reject(e.getMessage());
            }
        });
    }

    @PluginMethod
    public void configure(PluginCall call) {
        String profile = call.getString("deviceProfile");
        if (profile != null) host.setDeviceProfile(profile);
        call.resolve();
    }

    @PluginMethod
    public void attach(PluginCall call) {
        host.setObserved(true);
        main.post(() -> {
            call.resolve();
            host.snapshot();
        });
    }

    @PluginMethod
    public void detach(PluginCall call) {
        host.setObserved(false);
        call.resolve();
    }

    @PluginMethod
    public void setQueue(PluginCall call) {
        List<MediaItem> items = tracks(call.getArray("tracks"));
        int index = call.getInt("index", 0);
        long startMs = (long) (call.getDouble("startAt", 0.0) * 1000);
        boolean autoplay = call.getBoolean("autoplay", true);
        run(call, () -> host.setQueue(items, index, startMs, autoplay));
    }

    @PluginMethod
    public void updateQueue(PluginCall call) {
        List<MediaItem> items = tracks(call.getArray("tracks"));
        int index = call.getInt("index", 0);
        run(call, () -> host.updateQueue(items, index));
    }

    /** Audiobook parts: plain URLs played back to back. */
    @PluginMethod
    public void loadParts(PluginCall call) {
        List<MediaItem> items = new ArrayList<>();
        JSArray parts = call.getArray("parts");
        MediaMetadata md = new MediaMetadata.Builder()
                .setTitle(call.getString("title", ""))
                .setArtist(call.getString("artist"))
                .setAlbumTitle(call.getString("album"))
                .setArtworkUri(artwork(call.getString("artworkUrl")))
                .setIsPlayable(true).setIsBrowsable(false)
                .setMediaType(MediaMetadata.MEDIA_TYPE_AUDIO_BOOK_CHAPTER)
                .build();
        try {
            for (int i = 0; i < parts.length(); i++) {
                String url = parts.getJSONObject(i).getString("url");
                if (url.startsWith(CAPACITOR_FILE)) url = "file:///" + url.substring(CAPACITOR_FILE.length());
                items.add(new MediaItem.Builder().setMediaId("p:" + i).setUri(url).setMediaMetadata(md).build());
            }
        } catch (JSONException e) {
            call.reject("bad parts");
            return;
        }
        int index = call.getInt("index", 0);
        long startMs = (long) (call.getDouble("startAt", 0.0) * 1000);
        boolean autoplay = call.getBoolean("autoplay", true);
        float rate = call.getFloat("rate", 1f);
        MusicHost.Book book = book(call.getObject("book"), parts.length());
        run(call, () -> {
            host.setQueue(items, index, startMs, autoplay);
            host.setBook(book);
            host.exo().setPlaybackParameters(new PlaybackParameters(rate, 1f));
        });
    }

    @PluginMethod
    public void play(PluginCall call) {
        run(call, () -> host.exo().play());
    }

    @PluginMethod
    public void pause(PluginCall call) {
        run(call, () -> host.exo().pause());
    }

    @PluginMethod
    public void seek(PluginCall call) {
        long ms = (long) (call.getDouble("position", 0.0) * 1000);
        Integer index = call.getInt("index");
        run(call, () -> {
            Player p = host.exo();
            p.seekTo(index == null ? p.getCurrentMediaItemIndex() : index, ms);
        });
    }

    @PluginMethod
    public void skipTo(PluginCall call) {
        int index = call.getInt("index", 0);
        run(call, () -> host.exo().seekTo(index, C.TIME_UNSET));
    }

    @PluginMethod
    public void setRate(PluginCall call) {
        float rate = call.getFloat("rate", 1f);
        run(call, () -> host.exo().setPlaybackParameters(new PlaybackParameters(rate, 1f)));
    }

    @PluginMethod
    public void setGain(PluginCall call) {
        String mode = call.getString("mode", "track");
        int preamp = call.getInt("preamp", 0);
        double duck = call.getDouble("duck", 1.0);
        run(call, () -> host.setGain(mode, preamp, duck));
    }

    @PluginMethod
    public void setStems(PluginCall call) {
        String key = call.getString("key", "");
        String instrumental = call.getString("instrumentalUrl", "");
        String vocals = call.getString("vocalsUrl", "");
        run(call, () -> host.setStems(key, instrumental, vocals));
    }

    @PluginMethod
    public void setStemMix(PluginCall call) {
        float main = call.getFloat("main", 1f);
        float instrumental = call.getFloat("instrumental", 0f);
        float vocals = call.getFloat("vocals", 0f);
        run(call, () -> host.setStemMix(main, instrumental, vocals));
    }

    @PluginMethod
    public void clearStems(PluginCall call) {
        run(call, host::clearStems);
    }

    @PluginMethod
    public void setRepeat(PluginCall call) {
        String mode = call.getString("mode", "off");
        run(call, () -> host.exo().setRepeatMode("one".equals(mode) ? Player.REPEAT_MODE_ONE
                : "all".equals(mode) ? Player.REPEAT_MODE_ALL : Player.REPEAT_MODE_OFF));
    }

    @PluginMethod
    public void setRouted(PluginCall call) {
        host.setRouted(call.getBoolean("routed", false));
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        run(call, host::stop);
    }

    private android.net.Uri artwork(String url) {
        return url == null || url.isEmpty() ? null : android.net.Uri.parse(host.absolute(url));
    }

    /** What native progress beats need for the parts, null when the web layer did not send it. */
    private static MusicHost.Book book(JSObject o, int parts) {
        if (o == null) return null;
        try {
            JSONArray offsets = o.getJSONArray("offsets");
            if (offsets.length() != parts) return null;
            double[] at = new double[parts];
            for (int i = 0; i < parts; i++) at[i] = offsets.getDouble(i);
            return new MusicHost.Book(o.getLong("mediaId"), o.getLong("itemId"), o.getLong("mediaFileId"),
                    o.optString("sessionId"), o.getDouble("durationSeconds"), at);
        } catch (JSONException e) {
            return null;
        }
    }

    private List<MediaItem> tracks(JSArray array) {
        List<MediaItem> out = new ArrayList<>();
        try {
            for (int i = 0; i < array.length(); i++) {
                JSONObject t = array.getJSONObject(i);
                out.add(MusicCatalog.queueItem(t.getLong("itemId"), t.getLong("mediaId"), t.optString("title"),
                        t.optString("artists"), t.optString("albumTitle"),
                        t.isNull("coverUrl") ? null : host.absolute(t.getString("coverUrl")),
                        num(t, "durationSeconds"), num(t, "gain"), num(t, "peak"), num(t, "albumGain"),
                        num(t, "albumPeak"), localFile(t.isNull("localUrl") ? null : t.getString("localUrl"))));
            }
        } catch (JSONException e) {
            throw new IllegalArgumentException(e);
        }
        return out;
    }

    @Nullable
    private static String localFile(@Nullable String url) {
        if (url == null || url.isEmpty()) return null;
        return url.startsWith(CAPACITOR_FILE) ? "file:///" + url.substring(CAPACITOR_FILE.length()) : url;
    }

    private static double num(JSONObject o, String key) {
        return o.isNull(key) ? Double.NaN : o.optDouble(key, Double.NaN);
    }
}
