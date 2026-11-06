package media.fliks.app;

import android.content.Intent;
import android.net.Uri;

import androidx.activity.result.ActivityResultLauncher;
import androidx.browser.auth.AuthTabIntent;
import androidx.browser.customtabs.CustomTabsClient;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Collections;

/** Runs the OpenID Connect authorization in an Auth Tab; resolves `fallback` when the browser has none. */
@CapacitorPlugin(name = "WebAuth")
public class WebAuthPlugin extends Plugin {

    private ActivityResultLauncher<Intent> launcher;
    private PluginCall pending;

    @Override
    public void load() {
        launcher = AuthTabIntent.registerActivityResultLauncher(getActivity(), result -> {
            PluginCall call = pending;
            pending = null;
            if (call == null) {
                // The activity was recreated mid-flow: hand the callback to the app-wide appUrlOpen listener.
                if (result.resultCode == AuthTabIntent.RESULT_OK && result.resultUri != null) {
                    getBridge().onNewIntent(new Intent(Intent.ACTION_VIEW, result.resultUri));
                }
            } else if (result.resultCode == AuthTabIntent.RESULT_OK && result.resultUri != null) {
                call.resolve(new JSObject().put("url", result.resultUri.toString()));
            } else if (result.resultCode == AuthTabIntent.RESULT_CANCELED) {
                call.reject("canceled", "canceled");
            } else {
                call.reject("Sign-in failed");
            }
        });
    }

    @PluginMethod()
    public void start(PluginCall call) {
        String url = call.getString("url");
        String scheme = call.getString("callbackScheme");
        if (url == null || scheme == null) {
            call.reject("Invalid url");
            return;
        }
        String browser = CustomTabsClient.getPackageName(getContext(), Collections.emptyList());
        if (browser == null || !CustomTabsClient.isAuthTabSupported(getContext(), browser)) {
            call.resolve(new JSObject().put("fallback", true));
            return;
        }
        getActivity().runOnUiThread(() -> {
            if (pending != null) {
                call.reject("busy");
                return;
            }
            pending = call;
            try {
                new AuthTabIntent.Builder().build().launch(launcher, Uri.parse(url), scheme);
            } catch (RuntimeException e) {
                pending = null;
                call.reject("Could not start the sign-in", e);
            }
        });
    }
}
