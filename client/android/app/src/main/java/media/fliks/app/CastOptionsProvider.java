package media.fliks.app;

import android.content.Context;

import com.google.android.gms.cast.framework.CastOptions;
import com.google.android.gms.cast.framework.OptionsProvider;
import com.google.android.gms.cast.framework.SessionProvider;

import java.util.List;

/**
 * Required by the Cast Framework to initialize with the receiver app ID.
 * Declared in AndroidManifest.xml as a meta-data value.
 *
 * The receiver ID lives in `res/values/strings.xml` (cast_receiver_app_id)
 * so a single edit covers both the native Cast options and the Capacitor
 * plugin's web-side initialize call. Keep it in sync with `castAppId`
 * in `client/src/environments/environment.ts`.
 */
public class CastOptionsProvider implements OptionsProvider {
    @Override
    public CastOptions getCastOptions(Context context) {
        return new CastOptions.Builder()
            .setReceiverApplicationId(context.getString(R.string.cast_receiver_app_id))
            .build();
    }

    @Override
    public List<SessionProvider> getAdditionalSessionProviders(Context context) {
        return null;
    }
}
