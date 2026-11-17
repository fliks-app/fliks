package media.fliks.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class StemCompanionsTest {
    @Test
    public void reseeksOnlyPastTheDriftTolerance() {
        assertFalse(StemCompanions.needsReseek(10_000, 10_500));
        assertTrue(StemCompanions.needsReseek(10_000, 10_501));
        assertTrue(StemCompanions.needsReseek(10_600, 10_000));
    }
}
