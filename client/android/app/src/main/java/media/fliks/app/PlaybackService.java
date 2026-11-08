package media.fliks.app;

import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;

import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.session.CommandButton;
import androidx.media3.session.DefaultMediaNotificationProvider;
import androidx.media3.session.MediaNotification;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaLibraryService;

import com.google.common.collect.ImmutableList;

import java.util.ArrayList;
import java.util.List;

/** Foreground host for the notification sessions (local player, remote target) and the music
 *  library session, the only one controllers outside the app (Android Auto) can reach. */
public class PlaybackService extends MediaLibraryService {
    static final String MUSIC_SESSION_ID = "fliks-music";
    @Nullable private MediaLibrarySession library;

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
        stopIfIdle(context);
    }

    /** The music queue was cleared: the service goes when no other session needs it. */
    static void musicStopped(Context context) {
        stopIfIdle(context);
    }

    static void start(Context context) {
        if (instance == null) context.startService(new Intent(context, PlaybackService.class));
    }

    @OptIn(markerClass = UnstableApi.class)
    private static void stopIfIdle(Context context) {
        if (!sessions.isEmpty() || MusicHost.loaded()) return;
        context.stopService(new Intent(context, PlaybackService.class));
        // A notification detached from the foreground on pause outlives the service,
        // and an update already queued can still post it: cancel now and once it has run.
        Runnable cancel = () -> {
            if (sessions.isEmpty() && !MusicHost.loaded()) {
                context.getSystemService(NotificationManager.class)
                        .cancel(DefaultMediaNotificationProvider.DEFAULT_NOTIFICATION_ID);
            }
        };
        cancel.run();
        new Handler(Looper.getMainLooper()).postDelayed(cancel, 500);
    }

    @OptIn(markerClass = UnstableApi.class)
    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        setMediaNotificationProvider(new DetachAwareProvider(new DefaultMediaNotificationProvider(this)));
        library = MusicHost.get(this).createSession(this);
        addSession(library);
        for (MediaSession s : sessions) addSession(s);
    }

    @Override
    public void onDestroy() {
        instance = null;
        library = null;
        MusicHost.get(this).releaseSession();
        super.onDestroy();
    }

    /** A library service can only hand out its library session; the notification
     *  sessions are added to it and keep their own notifications. */
    @Nullable
    @Override
    public MediaLibrarySession onGetSession(MediaSession.ControllerInfo controllerInfo) {
        return library;
    }

    /** Media3 finishes an update (the artwork loads asynchronously) without checking
     *  the session is still attached, which re-posts a notification for it. */
    @OptIn(markerClass = UnstableApi.class)
    private static final class DetachAwareProvider implements MediaNotification.Provider {
        private final MediaNotification.Provider delegate;

        DetachAwareProvider(MediaNotification.Provider delegate) {
            this.delegate = delegate;
        }

        @Override
        public MediaNotification createNotification(MediaSession session,
                ImmutableList<CommandButton> mediaButtonPreferences,
                MediaNotification.ActionFactory actionFactory, Callback callback) {
            return delegate.createNotification(session, mediaButtonPreferences, actionFactory,
                    notification -> {
                        if (sessions.contains(session) || MUSIC_SESSION_ID.equals(session.getId())) callback.onNotificationChanged(notification);
                    });
        }

        @Override
        public boolean handleCustomCommand(MediaSession session, String action, Bundle extras) {
            return delegate.handleCustomCommand(session, action, extras);
        }

        @Override
        public NotificationChannelInfo getNotificationChannelInfo() {
            return delegate.getNotificationChannelInfo();
        }
    }

    /** The WebView driving both sessions goes with the task. The local player
     *  pauses; a remote target keeps playing, only its notification goes. */
    @Override
    public void onTaskRemoved(@Nullable Intent rootIntent) {
        for (MediaSession s : getSessions()) {
            if (!(s.getPlayer() instanceof RemoteStatePlayer) && !MUSIC_SESSION_ID.equals(s.getId())) s.getPlayer().pause();
        }
        if (MusicHost.loaded()) MusicHost.get(this).exo().pause();
        stopSelf();
    }
}
