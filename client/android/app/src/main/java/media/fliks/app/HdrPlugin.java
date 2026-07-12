package media.fliks.app;

import android.os.Build;
import android.view.Display;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Capacitor plugin to detect HDR display capabilities on Android.
 *
 * Usage from JS:
 *   const { supported, dolbyVision } = await Hdr.isSupported();
 */
@CapacitorPlugin(name = "Hdr")
public class HdrPlugin extends Plugin {

    @PluginMethod()
    public void isSupported(PluginCall call) {
        boolean supported = false;
        boolean dolbyVision = false;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Display display = getActivity().getWindowManager().getDefaultDisplay();
            Display.HdrCapabilities hdrCaps = display.getHdrCapabilities();
            if (hdrCaps != null) {
                int[] types = hdrCaps.getSupportedHdrTypes();
                supported = types != null && types.length > 0;
                if (types != null) {
                    for (int t : types) {
                        if (t == Display.HdrCapabilities.HDR_TYPE_DOLBY_VISION) {
                            dolbyVision = true;
                            break;
                        }
                    }
                }
            }
        }

        JSObject result = new JSObject();
        result.put("supported", supported);
        result.put("dolbyVision", dolbyVision);
        call.resolve(result);
    }
}
