package media.fliks.app;

import static org.junit.Assert.assertEquals;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import org.junit.Test;

public class MusicHostTest {
    @Test
    public void theOriginalOrderMapsDuplicatesOnceAndKeepsAddedEntriesLast() {
        List<Long> original = Arrays.asList(1L, 2L, 1L, 3L);
        List<Long> now = Arrays.asList(3L, 1L, 4L, 1L, 2L);
        assertEquals(Arrays.asList(1, 4, 3, 0, 2), MusicHost.originalOrder(original, now));
    }

    @Test
    public void anOrderIsAppliedByMoves() {
        List<String> entries = new ArrayList<>(Arrays.asList("a", "b", "c", "d", "e"));
        List<Integer> order = Arrays.asList(3, 0, 4, 2, 1);
        MusicHost.reorder(order, (from, to) -> entries.add(to, entries.remove((int) from)));
        assertEquals(Arrays.asList("d", "a", "e", "c", "b"), entries);
    }
}
