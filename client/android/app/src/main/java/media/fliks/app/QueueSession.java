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

/** A notification session whose previous/next are custom commands: the queue lives
 *  in JS, and a disabled button would be dropped rather than greyed. */
final class QueueSession {
    private static final SessionCommand NEXT = new SessionCommand("fliks.NEXT", Bundle.EMPTY);
    private static final SessionCommand PREVIOUS = new SessionCommand("fliks.PREVIOUS", Bundle.EMPTY);

    private QueueSession() {}

    static MediaSession build(Context context, Player player, String id, Runnable onPrevious, Runnable onNext) {
        Intent open = new Intent(context, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return new MediaSession.Builder(context, player)
                .setId(id)
                .setSessionActivity(PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_IMMUTABLE))
                .setCallback(new Callback(onPrevious, onNext))
                .setMediaButtonPreferences(buttons(context, false))
                .build();
    }

    static void setHasNext(Context context, MediaSession session, boolean hasNext) {
        session.setMediaButtonPreferences(buttons(context, hasNext));
    }

    @OptIn(markerClass = UnstableApi.class)
    private static ImmutableList<CommandButton> buttons(Context context, boolean hasNext) {
        ImmutableList.Builder<CommandButton> buttons = ImmutableList.builder();
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
        return buttons.build();
    }

    private static final class Callback implements MediaSession.Callback {
        private final Runnable onPrevious;
        private final Runnable onNext;

        Callback(Runnable onPrevious, Runnable onNext) {
            this.onPrevious = onPrevious;
            this.onNext = onNext;
        }

        @OptIn(markerClass = UnstableApi.class)
        @NonNull
        @Override
        public MediaSession.ConnectionResult onConnect(
                @NonNull MediaSession session, @NonNull MediaSession.ControllerInfo controller) {
            return new MediaSession.ConnectionResult.AcceptedResultBuilder(session)
                    .setAvailableSessionCommands(MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS
                            .buildUpon().add(NEXT).add(PREVIOUS).build())
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
            if (NEXT.customAction.equals(command.customAction)) onNext.run();
            else if (PREVIOUS.customAction.equals(command.customAction)) onPrevious.run();
            return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS));
        }
    }
}
