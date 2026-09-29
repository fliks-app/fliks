package media.fliks.app;

import android.os.Looper;

import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.DeviceInfo;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.SimpleBasePlayer;
import androidx.media3.common.util.UnstableApi;

import com.google.common.collect.ImmutableList;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;

/** Mirrors a remote target's reported state for its notification; every control
 *  is forwarded to JS, which sends the remote command. Volume is on a 0..100 scale. */
@OptIn(markerClass = UnstableApi.class)
final class RemoteStatePlayer extends SimpleBasePlayer {
    interface Sink {
        void send(String action, double value);
    }

    private static final int MAX_VOLUME = 100;
    private final Sink sink;
    private MediaMetadata metadata = MediaMetadata.EMPTY;
    private boolean playing;
    private boolean buffering;
    private long positionMs;
    private long durationMs;
    private boolean canSetVolume;
    private int volume;
    private boolean muted;

    RemoteStatePlayer(Looper looper, Sink sink) {
        super(looper);
        this.sink = sink;
    }

    void update(MediaMetadata metadata, boolean playing, boolean buffering, long positionMs,
                long durationMs, boolean canSetVolume, int volume, boolean muted) {
        this.metadata = metadata;
        this.playing = playing;
        this.buffering = buffering;
        this.positionMs = positionMs;
        this.durationMs = durationMs;
        this.canSetVolume = canSetVolume;
        this.volume = volume;
        this.muted = muted;
        invalidateState();
    }

    @Override
    protected State getState() {
        Commands.Builder commands = new Commands.Builder().addAll(
                COMMAND_PLAY_PAUSE, COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM, COMMAND_GET_CURRENT_MEDIA_ITEM,
                COMMAND_GET_METADATA, COMMAND_GET_TIMELINE, COMMAND_GET_DEVICE_VOLUME);
        if (canSetVolume) {
            commands.addAll(COMMAND_SET_DEVICE_VOLUME_WITH_FLAGS, COMMAND_ADJUST_DEVICE_VOLUME_WITH_FLAGS);
        }
        MediaItemData item = new MediaItemData.Builder("remote")
                .setMediaMetadata(metadata)
                .setDurationUs(durationMs > 0 ? durationMs * 1000 : C.TIME_UNSET)
                .setIsSeekable(true)
                .build();
        return new State.Builder()
                .setAvailableCommands(commands.build())
                .setPlaylist(ImmutableList.of(item))
                .setPlayWhenReady(playing || buffering, PLAY_WHEN_READY_CHANGE_REASON_REMOTE)
                .setPlaybackState(buffering ? STATE_BUFFERING : STATE_READY)
                .setContentPositionMs(playing && !buffering
                        ? PositionSupplier.getExtrapolating(positionMs, 1f)
                        : PositionSupplier.getConstant(positionMs))
                .setDeviceInfo(new DeviceInfo.Builder(DeviceInfo.PLAYBACK_TYPE_REMOTE)
                        .setMaxVolume(MAX_VOLUME).build())
                .setDeviceVolume(volume)
                .setIsDeviceMuted(muted)
                .build();
    }

    @Override
    protected ListenableFuture<?> handleSetPlayWhenReady(boolean playWhenReady) {
        playing = playWhenReady;
        sink.send(playWhenReady ? "play" : "pause", 0);
        return Futures.immediateVoidFuture();
    }

    @Override
    protected ListenableFuture<?> handleSeek(int mediaItemIndex, long positionMs, int seekCommand) {
        this.positionMs = positionMs;
        sink.send("seek", positionMs / 1000.0);
        return Futures.immediateVoidFuture();
    }

    @Override
    protected ListenableFuture<?> handleSetDeviceVolume(int deviceVolume, int flags) {
        return setVolume(deviceVolume);
    }

    @Override
    protected ListenableFuture<?> handleIncreaseDeviceVolume(int flags) {
        return setVolume(volume + 5);
    }

    @Override
    protected ListenableFuture<?> handleDecreaseDeviceVolume(int flags) {
        return setVolume(volume - 5);
    }

    private ListenableFuture<?> setVolume(int level) {
        volume = Math.max(0, Math.min(MAX_VOLUME, level));
        sink.send("volume", volume / (double) MAX_VOLUME);
        return Futures.immediateVoidFuture();
    }
}
