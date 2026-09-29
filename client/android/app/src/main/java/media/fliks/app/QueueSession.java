package media.fliks.app;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

import androidx.annotation.NonNull;
import androidx.annotation.OptIn;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.session.CommandButton;
import androidx.media3.session.MediaSession;
import androidx.media3.session.SessionCommand;
import androidx.media3.session.SessionResult;

import com.google.common.collect.ImmutableList;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;

/** A notification session whose buttons are custom commands answered in JS: the
 *  queue and likes live there, and a disabled button is dropped rather than greyed. */
final class QueueSession {
    private static final SessionCommand NEXT = new SessionCommand("fliks.NEXT", Bundle.EMPTY);
    private static final SessionCommand PREVIOUS = new SessionCommand("fliks.PREVIOUS", Bundle.EMPTY);
    private static final SessionCommand STOP = new SessionCommand("fliks.STOP", Bundle.EMPTY);
    private static final SessionCommand LIKE = new SessionCommand("fliks.LIKE", Bundle.EMPTY);

    interface Handlers {
        void previous();
        void next();
        void stop();
        void toggleLike();
    }

    private QueueSession() {}

    static MediaSession build(Context context, Player player, String id, Handlers handlers) {
        Intent open = new Intent(context, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return new MediaSession.Builder(context, player)
                .setId(id)
                .setSessionActivity(PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_IMMUTABLE))
                .setCallback(new Callback(handlers))
                .setMediaButtonPreferences(buttons(context, false, null))
                .build();
    }

    /** `liked` null hides the heart: the item has no like state (yet). */
    static void setState(Context context, MediaSession session, boolean hasNext, @androidx.annotation.Nullable Boolean liked) {
        session.setMediaButtonPreferences(buttons(context, hasNext, liked));
    }

    @OptIn(markerClass = UnstableApi.class)
    private static ImmutableList<CommandButton> buttons(Context context, boolean hasNext, @androidx.annotation.Nullable Boolean liked) {
        ImmutableList.Builder<CommandButton> buttons = ImmutableList.builder();
        buttons.add(new CommandButton.Builder(CommandButton.ICON_STOP)
                .setSessionCommand(STOP)
                .setDisplayName(context.getString(R.string.notification_stop))
                .setSlots(CommandButton.SLOT_OVERFLOW)
                .build());
        buttons.add(new CommandButton.Builder(CommandButton.ICON_PREVIOUS)
                .setSessionCommand(PREVIOUS)
                .setDisplayName(context.getString(androidx.media3.ui.R.string.exo_controls_previous_description))
                .setSlots(CommandButton.SLOT_BACK)
                .build());
        if (hasNext) {
            buttons.add(new CommandButton.Builder(CommandButton.ICON_NEXT)
                    .setSessionCommand(NEXT)
                    .setDisplayName(context.getString(androidx.media3.ui.R.string.exo_controls_next_description))
                    .setSlots(CommandButton.SLOT_FORWARD)
                    .build());
        }
        if (liked != null) {
            buttons.add(new CommandButton.Builder(liked ? CommandButton.ICON_HEART_FILLED : CommandButton.ICON_HEART_UNFILLED)
                    .setSessionCommand(LIKE)
                    .setDisplayName(context.getString(liked ? R.string.notification_unlike : R.string.notification_like))
                    .setSlots(CommandButton.SLOT_OVERFLOW)
                    .build());
        }
        return buttons.build();
    }

    private static final class Callback implements MediaSession.Callback {
        private final Handlers handlers;

        Callback(Handlers handlers) {
            this.handlers = handlers;
        }

        @OptIn(markerClass = UnstableApi.class)
        @NonNull
        @Override
        public MediaSession.ConnectionResult onConnect(
                @NonNull MediaSession session, @NonNull MediaSession.ControllerInfo controller) {
            return new MediaSession.ConnectionResult.AcceptedResultBuilder(session)
                    .setAvailableSessionCommands(MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS
                            .buildUpon().add(NEXT).add(PREVIOUS).add(STOP).add(LIKE).build())
                    .setAvailablePlayerCommands(MediaSession.ConnectionResult.DEFAULT_PLAYER_COMMANDS
                            .buildUpon()
                            .removeAll(Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
                                    Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
                            .build())
                    .build();
        }

        @NonNull
        @Override
        public ListenableFuture<SessionResult> onCustomCommand(
                @NonNull MediaSession session, @NonNull MediaSession.ControllerInfo controller,
                @NonNull SessionCommand command, @NonNull Bundle args) {
            String action = command.customAction;
            if (NEXT.customAction.equals(action)) handlers.next();
            else if (PREVIOUS.customAction.equals(action)) handlers.previous();
            else if (STOP.customAction.equals(action)) handlers.stop();
            else if (LIKE.customAction.equals(action)) handlers.toggleLike();
            return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS));
        }
    }
}
