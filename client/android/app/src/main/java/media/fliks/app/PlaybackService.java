package media.fliks.app;

import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;

import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.session.DefaultMediaNotificationProvider;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;

import java.util.ArrayList;
import java.util.List;

/** Foreground host for the notification sessions (local player, remote target);
 *  Media3 posts each notification and promotes the service while one plays. */
public class PlaybackService extends MediaSessionService {
    private static final List<MediaSession> sessions = new ArrayList<>();
    @Nullable private static PlaybackService instance;

    static void attach(Context context, MediaSession session) {
        sessions.add(session);
        if (instance != null) instance.addSession(session);
        else context.startService(new Intent(context, PlaybackService.class));
    }

    @OptIn(markerClass = UnstableApi.class)
    static void detach(Context context, MediaSession session) {
        sessions.remove(session);
        if (instance != null) instance.removeSession(session);
        if (!sessions.isEmpty()) return;
        context.stopService(new Intent(context, PlaybackService.class));
        // A notification detached from the foreground on pause outlives the service.
        context.getSystemService(NotificationManager.class)
                .cancel(DefaultMediaNotificationProvider.DEFAULT_NOTIFICATION_ID);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        for (MediaSession s : sessions) addSession(s);
    }

    @Override
    public void onDestroy() {
        instance = null;
        super.onDestroy();
    }

    @Nullable
    @Override
    public MediaSession onGetSession(MediaSession.ControllerInfo controllerInfo) {
        return sessions.isEmpty() ? null : sessions.get(0);
    }

    /** The WebView driving both sessions goes with the task. The local player
     *  pauses; a remote target keeps playing, only its notification goes. */
    @Override
    public void onTaskRemoved(@Nullable Intent rootIntent) {
        for (MediaSession s : getSessions()) {
            if (!(s.getPlayer() instanceof RemoteStatePlayer)) s.getPlayer().pause();
        }
        stopSelf();
    }
}
