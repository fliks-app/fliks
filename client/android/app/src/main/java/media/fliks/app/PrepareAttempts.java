package media.fliks.app;

import androidx.annotation.Nullable;

import java.io.IOException;

/** The attempts to open a source that can be prepared again: a result of an older attempt is dropped. */
final class PrepareAttempts {
    private static final class Failure {
        final int attempt;
        final IOException error;

        Failure(int attempt, IOException error) {
            this.attempt = attempt;
            this.error = error;
        }
    }

    private volatile int current;
    @Nullable private volatile Failure failure;

    /** A prepare starts; returns its attempt number. */
    int begin() {
        return ++current;
    }

    /** A release: whatever is still running belongs to no attempt. */
    void end() {
        current++;
    }

    boolean isCurrent(int attempt) {
        return attempt == current;
    }

    void fail(int attempt, IOException error) {
        failure = new Failure(attempt, error);
    }

    void throwIfFailed() throws IOException {
        Failure f = failure;
        if (f != null && f.attempt == current) throw f.error;
    }
}
