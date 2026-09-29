package media.fliks.app;

import android.view.Window;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Capacitor plugin to toggle Android immersive mode.
 * Hides status bar and navigation bar; the cutout mode stays the app-wide baseline.
 *
 * Usage from JS:
 *   Immersive.enter({ displayBehindNotch: true })
 *   Immersive.exit()
 */
@CapacitorPlugin(name = "Immersive")
public class ImmersivePlugin extends Plugin {

    @PluginMethod()
    public void enter(PluginCall call) {

        getActivity().runOnUiThread(() -> {
            Window window = getActivity().getWindow();
            WindowCompat.setDecorFitsSystemWindows(window, false);

            // Tell MainActivity to stop applying system bar padding
            if (getActivity() instanceof MainActivity) {
                ((MainActivity) getActivity()).setImmersiveMode(true);
            }

            WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(window, window.getDecorView());
            controller.hide(WindowInsetsCompat.Type.systemBars());
            controller.setSystemBarsBehavior(
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            call.resolve();
        });
    }

    @PluginMethod()
    public void applyEdgeToEdge(PluginCall call) {
        if (getActivity() instanceof MainActivity) {
            ((MainActivity) getActivity()).reapplyEdgeToEdge();
        }
        call.resolve();
    }

    @PluginMethod()
    public void setLightStatusBar(PluginCall call) {
        boolean light = call.getBoolean("light", false);
        getActivity().runOnUiThread(() -> {
            if (getActivity() instanceof MainActivity) {
                ((MainActivity) getActivity()).setLightStatusBar(light);
            }
        });
        call.resolve();
    }

    @PluginMethod()
    public void exit(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            Window window = getActivity().getWindow();
            // Edge-to-edge is the app-wide baseline (set in MainActivity).
            // Keep it on when leaving immersive mode — only the bar
            // visibility toggles back, layout stays under the bars so
            // CSS env(safe-area-inset-*) keeps returning real values.
            WindowCompat.setDecorFitsSystemWindows(window, false);

            // Tell MainActivity to re-apply system bar padding
            if (getActivity() instanceof MainActivity) {
                ((MainActivity) getActivity()).setImmersiveMode(false);
            }

            WindowCompat.getInsetsController(window, window.getDecorView())
                .show(WindowInsetsCompat.Type.systemBars());
            // Re-assert edge-to-edge now the bars are shown again: keep the
            // WebView drawing under them (full width) and re-dispatch the
            // insets + transparent bar colours. Without this the returning
            // bars take layout space — the status bar goes opaque (black) and
            // the narrower viewport flips the form factor back to phone.
            if (getActivity() instanceof MainActivity) {
                ((MainActivity) getActivity()).reapplyEdgeToEdge();
            }
            call.resolve();
        });
    }
}
