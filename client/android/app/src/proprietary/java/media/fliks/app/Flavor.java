package media.fliks.app;

import android.content.Context;
import com.getcapacitor.Plugin;
import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;
import com.google.android.gms.tasks.Tasks;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;
import java.util.List;
import java.util.concurrent.TimeUnit;

/** Google Cast and FCM, kept out of the libre build. */
final class Flavor {
    private Flavor() {}

    static final List<Class<? extends Plugin>> PLUGINS = List.of(CastPlugin.class);

    static boolean pushAvailable(Context ctx) {
        return !FirebaseApp.getApps(ctx).isEmpty()
            && GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(ctx) == ConnectionResult.SUCCESS;
    }

    static void enablePush() {
        FirebaseMessaging.getInstance().setAutoInitEnabled(true);
    }

    static String pushToken(long timeoutSeconds) throws Exception {
        return Tasks.await(FirebaseMessaging.getInstance().getToken(), timeoutSeconds, TimeUnit.SECONDS);
    }
}
