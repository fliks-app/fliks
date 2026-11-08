package media.fliks.app;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;

/** The instrumental and vocals stems of the playing track, two players slaved to the queue's player. */
@OptIn(markerClass = UnstableApi.class)
final class StemCompanions {
    static final long DRIFT_MS = 150;
    private static final long TICK_MS = 250;

    /** What a mix does to the sound: the queue player's own level and each stem's. */
    static final class Mix {
        final float main, instrumental, vocals;

        Mix(float main, float instrumental, float vocals) {
            this.main = main;
            this.instrumental = instrumental;
            this.vocals = vocals;
        }
    }

    /** True when a stem has drifted far enough from the queue player to be seeked. */
    static boolean needsReseek(long mainMs, long stemMs) {
        return Math.abs(mainMs - stemMs) > DRIFT_MS;
    }

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExoPlayer instrumental, vocals;
    private final Player main;
    private final Runnable onChange;
    private final Runnable onFailed;
    private final Runnable tick = this::tick;
    @Nullable private String key;
    private Mix mix = new Mix(1, 0, 0);

    StemCompanions(Context context, DataSource.Factory source, Player main, Runnable onChange, Runnable onFailed) {
        this.main = main;
        this.onChange = onChange;
        this.onFailed = onFailed;
        instrumental = build(context, source);
        vocals = build(context, source);
        main.addListener(new Player.Listener() {
            @Override public void onIsPlayingChanged(boolean playing) { sync(); }
            @Override public void onPlaybackParametersChanged(PlaybackParameters p) { sync(); }
            @Override public void onPositionDiscontinuity(Player.PositionInfo a, Player.PositionInfo b, int reason) { sync(); }
        });
    }

    private ExoPlayer build(Context context, DataSource.Factory source) {
        ExoPlayer p = new ExoPlayer.Builder(context)
                .setMediaSourceFactory(new DefaultMediaSourceFactory(context).setDataSourceFactory(source))
                .setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), false)
                .setLooper(Looper.getMainLooper())
                .build();
        p.setVolume(0f);
        p.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_READY) {
                    onChange.run();
                    sync();
                }
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                clear();
                onFailed.run();
            }
        });
        return p;
    }

    /** Loads the stems of `key` (the media file) unless they already are. */
    void load(String key, String instrumentalUrl, String vocalsUrl) {
        if (key.equals(this.key)) return;
        this.key = key;
        for (ExoPlayer p : new ExoPlayer[]{instrumental, vocals}) {
            p.stop();
            p.clearMediaItems();
        }
        instrumental.setMediaItem(MediaItem.fromUri(instrumentalUrl));
        vocals.setMediaItem(MediaItem.fromUri(vocalsUrl));
        instrumental.prepare();
        vocals.prepare();
        handler.removeCallbacks(tick);
        handler.post(tick);
        onChange.run();
    }

    void clear() {
        key = null;
        handler.removeCallbacks(tick);
        for (ExoPlayer p : new ExoPlayer[]{instrumental, vocals}) {
            p.stop();
            p.clearMediaItems();
        }
        onChange.run();
    }

    boolean active() {
        return key != null;
    }

    /** True once both stems can play: the queue player stays audible until then. */
    boolean ready() {
        return key != null && instrumental.getPlaybackState() == Player.STATE_READY
                && vocals.getPlaybackState() == Player.STATE_READY;
    }

    void setMix(Mix mix) {
        this.mix = mix;
        onChange.run();
    }

    /** The level of the queue player: silent while the stems carry the sound. */
    float mainLevel() {
        return ready() ? mix.main : 1f;
    }

    /** `scale` is the ReplayGain and ducking of the track, which the queue player's processor applies otherwise. */
    void setVolumes(float scale) {
        boolean r = ready();
        instrumental.setVolume(r ? Math.min(1f, mix.instrumental * scale) : 0f);
        vocals.setVolume(r ? Math.min(1f, mix.vocals * scale) : 0f);
    }

    private void tick() {
        if (key == null) return;
        sync();
        handler.postDelayed(tick, TICK_MS);
    }

    private void sync() {
        if (key == null) return;
        boolean run = main.isPlaying();
        long at = main.getCurrentPosition();
        PlaybackParameters rate = main.getPlaybackParameters();
        for (ExoPlayer p : new ExoPlayer[]{instrumental, vocals}) {
            if (!p.getPlaybackParameters().equals(rate)) p.setPlaybackParameters(rate);
            if (needsReseek(at, p.getCurrentPosition())) p.seekTo(at);
            if (p.getPlayWhenReady() != run) p.setPlayWhenReady(run);
        }
    }

    void release() {
        handler.removeCallbacks(tick);
        instrumental.release();
        vocals.release();
    }
}
