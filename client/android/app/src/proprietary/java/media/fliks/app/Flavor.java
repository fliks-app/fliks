package media.fliks.app;

import android.app.Activity;
import android.content.Intent;
import com.getcapacitor.Plugin;
import java.util.List;

/** Google Cast and FCM push, kept out of the libre build. */
final class Flavor {
    private Flavor() {}

    static final List<Class<? extends Plugin>> PLUGINS = List.of(CastPlugin.class, PushPlugin.class);

    static void handleIntent(Activity activity, Intent intent) {
        PushPlugin.handleIntent(activity, intent);
    }

    static void setForeground(boolean foreground) {
        PushNotifier.foreground = foreground;
    }
}
