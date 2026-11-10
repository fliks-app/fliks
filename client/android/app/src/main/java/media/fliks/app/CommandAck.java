package media.fliks.app;

import androidx.annotation.Nullable;

/** The remote command the service applied, owed to the server until a beat has carried its id. */
final class CommandAck {
    /** Past the sender's own wait an ack is worth nothing: the face stops being kept for it. */
    static final long GRACE_MS = 10_000;

    @Nullable private String id;
    private long appliedAt;
    private boolean owed;

    synchronized void applied(@Nullable String cmdId, long now) {
        id = cmdId;
        appliedAt = now;
        owed = cmdId != null;
    }

    /** The id the next beat carries; kept after it was sent, as the sender may match any later beat. */
    @Nullable
    synchronized String id() {
        return id;
    }

    synchronized boolean owed(long now) {
        return owed && now - appliedAt < GRACE_MS;
    }

    /** The beat that carried `cmdId` reached the server. */
    synchronized void sent(String cmdId) {
        if (cmdId.equals(id)) owed = false;
    }
}
