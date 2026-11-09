package media.fliks.app;

import android.os.Handler;

import androidx.annotation.Nullable;
import androidx.media3.common.MediaItem;
import androidx.media3.common.Timeline;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.common.util.Util;
import androidx.media3.datasource.TransferListener;
import androidx.media3.exoplayer.source.CompositeMediaSource;
import androidx.media3.exoplayer.source.MediaPeriod;
import androidx.media3.exoplayer.source.MediaSource;
import androidx.media3.exoplayer.upstream.Allocator;

import java.io.IOException;
import java.util.concurrent.Executor;

/** A source whose real item (a file or an HLS stream) is only known once the server has decided. */
@UnstableApi
final class DeferredMediaSource extends CompositeMediaSource<Void> {
    interface Opener {
        MediaItem open(MediaItem item) throws IOException;
    }

    private final MediaItem item;
    private final MediaSource.Factory factory;
    private final Opener opener;
    private final Executor io;
    @Nullable private volatile IOException failure;
    @Nullable private MediaSource child;
    private boolean released;

    DeferredMediaSource(MediaItem item, MediaSource.Factory factory, Opener opener, Executor io) {
        this.item = item;
        this.factory = factory;
        this.opener = opener;
        this.io = io;
    }

    @Override
    public MediaItem getMediaItem() {
        return item;
    }

    @Override
    protected void prepareSourceInternal(@Nullable TransferListener transferListener) {
        super.prepareSourceInternal(transferListener);
        Handler playback = Util.createHandlerForCurrentLooper();
        io.execute(() -> {
            try {
                MediaItem real = opener.open(item);
                playback.post(() -> {
                    if (released) return;
                    child = factory.createMediaSource(real);
                    prepareChildSource(null, child);
                });
            } catch (IOException e) {
                failure = e;
            }
        });
    }

    @Override
    public void maybeThrowSourceInfoRefreshError() throws IOException {
        IOException e = failure;
        if (e != null) throw e;
        super.maybeThrowSourceInfoRefreshError();
    }

    @Override
    protected void onChildSourceInfoRefreshed(Void id, MediaSource source, Timeline timeline) {
        refreshSourceInfo(timeline);
    }

    @Override
    public MediaPeriod createPeriod(MediaSource.MediaPeriodId id, Allocator allocator, long startPositionUs) {
        return child.createPeriod(id, allocator, startPositionUs);
    }

    @Override
    public void releasePeriod(MediaPeriod period) {
        child.releasePeriod(period);
    }

    @Override
    protected void releaseSourceInternal() {
        released = true;
        child = null;
        super.releaseSourceInternal();
    }
}
