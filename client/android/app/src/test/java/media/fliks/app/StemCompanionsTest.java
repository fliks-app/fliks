package media.fliks.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class StemCompanionsTest {
    @Test
    public void reseeksOnlyPastTheDriftTolerance() {
        assertFalse(StemCompanions.needsReseek(10_000, 10_150));
        assertTrue(StemCompanions.needsReseek(10_000, 10_151));
        assertTrue(StemCompanions.needsReseek(10_200, 10_000));
    }
}
