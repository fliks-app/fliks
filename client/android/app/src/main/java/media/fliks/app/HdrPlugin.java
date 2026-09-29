package media.fliks.app;

import android.os.Build;
import android.util.Log;
import android.view.Display;

import androidx.core.content.ContextCompat;

import java.util.Arrays;
import java.util.List;

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

    private static final String TAG = "FliksHdr";

    // ColorOS firmware gates the panel's HDR brightness boost on an OEM app whitelist,
    // so HDR renders at SDR luminance; report SDR so the server tonemaps instead.
    private static final List<String> HDR_INEFFECTIVE_MANUFACTURERS =
            Arrays.asList("oneplus", "oppo", "realme");

    @PluginMethod()
    public void isSupported(PluginCall call) {
        boolean supported = false;
        boolean dolbyVision = false;

        if (HDR_INEFFECTIVE_MANUFACTURERS.contains(Build.MANUFACTURER.toLowerCase())) {
            Log.i(TAG, "HDR reported unsupported: " + Build.MANUFACTURER
                    + " gates the HDR brightness boost on an app whitelist");
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Display display = ContextCompat.getDisplayOrDefault(getActivity());
            int[] types = supportedHdrTypes(display);
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

        JSObject result = new JSObject();
        result.put("supported", supported);
        result.put("dolbyVision", dolbyVision);
        call.resolve(result);
    }

    @SuppressWarnings("deprecation")
    private static int[] supportedHdrTypes(Display display) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            return display.getMode().getSupportedHdrTypes();
        }
        Display.HdrCapabilities caps = display.getHdrCapabilities();
        return caps != null ? caps.getSupportedHdrTypes() : null;
    }
}
