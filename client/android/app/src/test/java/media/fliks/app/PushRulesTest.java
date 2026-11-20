package media.fliks.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import org.junit.Test;

public class PushRulesTest {
    @Test
    public void requestCodesFollowTheTagAndThePurpose() {
        assertEquals(PushRules.requestCode("a", "open"), PushRules.requestCode("a", "open"));
        assertNotEquals(PushRules.requestCode("a", "open"), PushRules.requestCode("b", "open"));
        assertNotEquals(PushRules.requestCode("a", "open"), PushRules.requestCode("a", "call0"));
    }

    @Test
    public void onlyAHigherPlaintextVersionIsUnreadable() {
        assertFalse(PushRules.newerThanKnown(PushRules.PLAIN_VERSION));
        assertFalse(PushRules.newerThanKnown(0));
        assertTrue(PushRules.newerThanKnown(PushRules.PLAIN_VERSION + 1));
    }

    @Test
    public void aReplayedIdIsRefusedAndTheRingIsCut() {
        assertNull(PushRules.remember(Arrays.asList("a", "b"), "a"));
        List<String> ids = new ArrayList<>();
        for (int i = 0; i < PushRules.MAX_IDS + 5; i++) ids = PushRules.remember(ids, "id" + i);
        assertEquals(PushRules.MAX_IDS, ids.size());
        assertEquals("id5", ids.get(0));
    }

    @Test
    public void anEmptyIdIsNeverRemembered() {
        List<String> ids = Arrays.asList("a");
        assertSame(ids, PushRules.remember(ids, ""));
        assertSame(ids, PushRules.remember(ids, ""));
    }

    @Test
    public void onlyBadRequestAndNotFoundCountAsDeleted() {
        assertTrue(PushRelay.gone(400));
        assertTrue(PushRelay.gone(404));
        assertFalse(PushRelay.gone(401));
        assertFalse(PushRelay.gone(429));
        assertFalse(PushRelay.gone(500));
    }

    @Test
    public void theTwoSessionKeyFormatsAreDistinct() {
        assertEquals("https://s|3", PushStore.sessionKey("https://s", 3));
        assertEquals("https://s::3", PushStore.apiKey("https://s", "3"));
    }
}
