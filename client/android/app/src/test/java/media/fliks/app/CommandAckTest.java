package media.fliks.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class CommandAckTest {
    @Test
    public void anAppliedCommandIsOwedUntilItsBeatIsSent() {
        CommandAck ack = new CommandAck();
        assertFalse(ack.owed(0));
        ack.applied("c1", 0);
        assertTrue(ack.owed(1));
        ack.sent("c1");
        assertFalse(ack.owed(2));
        assertEquals("c1", ack.id());
    }

    @Test
    public void aBeatOfAnEarlierCommandDoesNotSettleTheLatest() {
        CommandAck ack = new CommandAck();
        ack.applied("c1", 0);
        ack.applied("c2", 10);
        ack.sent("c1");
        assertTrue(ack.owed(20));
    }

    @Test
    public void aDebtIsDroppedAfterTheGrace() {
        CommandAck ack = new CommandAck();
        ack.applied("c1", 0);
        assertFalse(ack.owed(CommandAck.GRACE_MS));
    }
}
