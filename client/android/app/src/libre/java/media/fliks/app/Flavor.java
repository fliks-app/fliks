package media.fliks.app;

import android.content.Context;
import com.getcapacitor.Plugin;
import java.util.List;

/** No proprietary services: Cast is absent and push reports itself unavailable. */
final class Flavor {
    private Flavor() {}

    static final List<Class<? extends Plugin>> PLUGINS = List.of();

    static boolean pushAvailable(Context ctx) {
        return false;
    }

    static void enablePush() {}

    static String pushToken(long timeoutSeconds) throws Exception {
        throw new UnsupportedOperationException("no push service in this build");
    }
}
