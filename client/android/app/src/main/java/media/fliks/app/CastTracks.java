package media.fliks.app;

import com.google.android.gms.cast.MediaInfo;
import com.google.android.gms.cast.MediaStatus;
import com.google.android.gms.cast.MediaTrack;
import com.google.android.gms.cast.framework.media.RemoteMediaClient;
import java.util.ArrayList;
import java.util.List;

/** Track queries and selection on the receiver's media status. */
final class CastTracks {
    private CastTracks() {}

    /**
     * The receiver's media tracks. MediaStatus' MediaInfo is preferred: it reflects
     * receiver-side setMediaInformation() updates, where the audio renditions are published.
     */
    static List<MediaTrack> mediaTracks(RemoteMediaClient client) {
        MediaStatus status = client.getMediaStatus();
        MediaInfo mediaInfo = status != null ? status.getMediaInfo() : null;
        if (mediaInfo == null) mediaInfo = client.getMediaInfo();
        return mediaInfo != null ? mediaInfo.getMediaTracks() : null;
    }

    /** The active track of one type, -1 when there is none. */
    static long activeTrackId(RemoteMediaClient client, List<MediaTrack> tracks, int type) {
        MediaStatus status = client.getMediaStatus();
        long[] active = status != null ? status.getActiveTrackIds() : null;
        if (active == null) return -1;
        for (long id : active) {
            for (MediaTrack t : tracks) {
                if (t.getId() == id && t.getType() == type) return id;
            }
        }
        return -1;
    }

    /** setActiveMediaTracks replaces the whole active set, so audio and text go together (-1: none). */
    static void setActiveTracks(RemoteMediaClient client, long audioId, long textId) {
        List<Long> ids = new ArrayList<>();
        if (audioId >= 0) ids.add(audioId);
        if (textId >= 0) ids.add(textId);
        long[] newActive = new long[ids.size()];
        for (int i = 0; i < newActive.length; i++) newActive[i] = ids.get(i);
        client.setActiveMediaTracks(newActive);
    }
}
