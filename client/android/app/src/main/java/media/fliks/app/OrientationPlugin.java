package media.fliks.app;

import android.content.pm.ActivityInfo;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Holds the player in landscape on phones; tablets keep free rotation. */
@CapacitorPlugin(name = "Orientation")
public class OrientationPlugin extends Plugin {

    @PluginMethod()
    public void landscape(PluginCall call) {
        // USER_LANDSCAPE flips between the two sides only when system auto-rotate is on.
        boolean tablet = getActivity().getResources().getConfiguration().smallestScreenWidthDp >= 600;
        apply(tablet ? ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                     : ActivityInfo.SCREEN_ORIENTATION_USER_LANDSCAPE);
        call.resolve();
    }

    @PluginMethod()
    public void unlock(PluginCall call) {
        apply(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        call.resolve();
    }

    private void apply(int orientation) {
        getActivity().runOnUiThread(() -> getActivity().setRequestedOrientation(orientation));
    }
}
