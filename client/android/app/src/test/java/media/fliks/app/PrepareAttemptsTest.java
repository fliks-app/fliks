package media.fliks.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.IOException;

import org.junit.Test;

public class PrepareAttemptsTest {
    @Test
    public void aFailureIsThrownUntilTheSourceIsPreparedAgain() throws IOException {
        PrepareAttempts a = new PrepareAttempts();
        int first = a.begin();
        a.fail(first, new IOException("token expired"));
        assertThrows(IOException.class, a::throwIfFailed);
        a.end();
        a.begin();
        a.throwIfFailed();
    }

    @Test
    public void aResultOfAnEarlierAttemptIsDroppedAfterARelease() throws IOException {
        PrepareAttempts a = new PrepareAttempts();
        int first = a.begin();
        a.end();
        int second = a.begin();
        assertFalse(a.isCurrent(first));
        assertTrue(a.isCurrent(second));
        a.fail(first, new IOException("late"));
        a.throwIfFailed();
    }

    @Test
    public void aReleaseDropsTheRunningAttempt() {
        PrepareAttempts a = new PrepareAttempts();
        int attempt = a.begin();
        a.end();
        assertFalse(a.isCurrent(attempt));
    }
}
