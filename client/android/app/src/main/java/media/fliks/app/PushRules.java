package media.fliks.app;

import java.util.ArrayList;
import java.util.List;

/** The device rules that need no Android: expiry and the ring of shown ids. */
final class PushRules {
    static final int MAX_IDS = 200;
    /** The plaintext version (`v`) this build reads; a higher one is shown as the generic text. */
    static final int PLAIN_VERSION = 1;

    private PushRules() {}

    static boolean newerThanKnown(int v) {
        return v > PLAIN_VERSION;
    }

    static boolean expired(long ts, long ttl, long nowSeconds) {
        return ts + ttl < nowSeconds;
    }

    /** Distinct PendingIntent request code per notification tag and purpose, stable across processes. */
    static int requestCode(String tag, String purpose) {
        return (tag + '#' + purpose).hashCode();
    }

    /** `ids` with `id` appended and cut to the last {@link #MAX_IDS}; null when `id` was already there.
     *  An empty id is not replayable: `ids` comes back unchanged. */
    static List<String> remember(List<String> ids, String id) {
        if (id.isEmpty()) return ids;
        if (ids.contains(id)) return null;
        List<String> next = new ArrayList<>(ids);
        next.add(id);
        return next.size() > MAX_IDS ? new ArrayList<>(next.subList(next.size() - MAX_IDS, next.size())) : next;
    }
}
