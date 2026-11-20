package media.fliks.app;

import android.app.Activity;
import android.content.Intent;
import com.getcapacitor.Plugin;
import java.util.List;

/** No proprietary services: the web layer hides Cast and push when their plugins are missing. */
final class Flavor {
    private Flavor() {}

    static final List<Class<? extends Plugin>> PLUGINS = List.of();

    static void handleIntent(Activity activity, Intent intent) {}

    static void setForeground(boolean foreground) {}
}
