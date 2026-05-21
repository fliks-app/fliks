package media.fliks.app;

import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.HttpDataSource;
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy;
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy;

/**
 * Custom LoadErrorHandlingPolicy that retries transient HTTP error
 * responses instead of treating them as terminal failures.
 *
 * Media3's default policy returns {@code C.TIME_UNSET} (= "give up")
 * on 403 / 404 / 410 / 416 / 500 / 503 response codes — designed for
 * static CDN-served content where these statuses are stable. Our
 * streaming pipeline serves segments from a live ffmpeg transcode
 * session, so a 404 in the first seconds after a quality switch is a
 * transient race condition (segment file not yet written) — the very
 * next request would succeed. The default policy fails the playback
 * before ffmpeg gets a chance to catch up.
 *
 * Override the retry decision: for the response codes the default
 * marks as terminal, return a backoff delay (1s, 2s, 4s, 8s, …)
 * capped by {@link DefaultLoadErrorHandlingPolicy#DEFAULT_TRACK_BLACKLIST_MS}.
 * Combined with a higher {@code minimumLoadableRetryCount}, the
 * loader keeps probing for ~10s before surfacing the error — long
 * enough to absorb the ffmpeg cold-start.
 */
@OptIn(markerClass = UnstableApi.class)
public class RetryHttp404LoadErrorPolicy extends DefaultLoadErrorHandlingPolicy {

    public RetryHttp404LoadErrorPolicy() {
        // Lift the retry count from the default 3 — the policy below
        // only matters if Media3 is willing to call us back this many
        // times. 8 with exponential backoff gives roughly 15 s of
        // tolerance before propagating the error.
        super(/* minimumLoadableRetryCount= */ 8);
    }

    @Override
    public long getRetryDelayMsFor(LoadErrorHandlingPolicy.LoadErrorInfo info) {
        if (info.exception instanceof HttpDataSource.InvalidResponseCodeException) {
            int code =
                ((HttpDataSource.InvalidResponseCodeException) info.exception).responseCode;
            if (code == 403
                || code == 404
                || code == 410
                || code == 416
                || code == 500
                || code == 503) {
                // Exponential backoff: 1s, 2s, 4s, 8s, …, capped at the
                // policy's blacklist window so we don't keep retrying
                // a permanently-dead URL forever.
                long delay = 1000L * (1L << Math.min(info.errorCount - 1, 4));
                return Math.min(delay, DEFAULT_TRACK_BLACKLIST_MS);
            }
        }
        return super.getRetryDelayMsFor(info);
    }
}
