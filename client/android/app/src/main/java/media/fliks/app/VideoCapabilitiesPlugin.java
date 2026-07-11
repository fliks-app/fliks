package media.fliks.app;

import android.media.MediaCodecInfo;
import android.media.MediaCodecList;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * Reports the video codecs the device's MediaCodec stack actually decodes, plus
 * the containers ExoPlayer demuxes. Playback on Android goes through ExoPlayer,
 * not the WebView, but the device profile's video codec list is otherwise built
 * from {@code MediaSource.isTypeSupported()} — which under-reports HEVC/AV1 on
 * the Android System WebView even when MediaCodec can decode them. That makes
 * HEVC sources fall back to a full H.264 transcode. Sourcing the codec list
 * from MediaCodecList instead lets HEVC (and MKV via the container list below)
 * Direct Play / remux with no re-encode.
 */
@CapacitorPlugin(name = "VideoCapabilities")
public class VideoCapabilitiesPlugin extends Plugin {

    @PluginMethod()
    public void getSupported(PluginCall call) {
        Set<String> codecs = new HashSet<>();
        // codec key -> the most capable decoder's [maxWidth, maxHeight]. Gates
        // Direct Play so a device whose HEVC/AV1 decoder tops out at 1080p
        // doesn't advertise unbounded support and black-screen on a 4K source.
        Map<String, int[]> maxRes = new HashMap<>();
        boolean hevcMain10 = false;
        boolean av1Main10 = false;
        try {
            MediaCodecList list = new MediaCodecList(MediaCodecList.REGULAR_CODECS);
            for (MediaCodecInfo info : list.getCodecInfos()) {
                if (info.isEncoder()) continue;
                for (String type : info.getSupportedTypes()) {
                    String key = mimeToCodecKey(type);
                    if (key == null) continue;
                    codecs.add(key);
                    try {
                        MediaCodecInfo.CodecCapabilities caps = info.getCapabilitiesForType(type);
                        if ("hevc".equals(key) && supportsMain10(caps, true)) hevcMain10 = true;
                        if ("av1".equals(key) && supportsMain10(caps, false)) av1Main10 = true;
                        MediaCodecInfo.VideoCapabilities vc = caps.getVideoCapabilities();
                        if (vc != null) {
                            int w = vc.getSupportedWidths().getUpper();
                            int h = vc.getSupportedHeights().getUpper();
                            int[] cur = maxRes.get(key);
                            // Keep the single most capable decoder (by area) so we
                            // never report a width/height pair no one decoder does.
                            if (cur == null || (long) w * h > (long) cur[0] * cur[1]) {
                                maxRes.put(key, new int[] { w, h });
                            }
                        }
                    } catch (Throwable ignored) { /* per-codec best-effort */ }
                }
            }
        } catch (Throwable ignored) { /* best-effort */ }

        JSArray arr = new JSArray();
        for (String c : codecs) arr.put(c);

        // ExoPlayer demuxes these containers regardless of device. mkv/webm are
        // the wins over the WebView (which can only Direct Play mp4/webm).
        JSArray containers = new JSArray();
        containers.put("mp4");
        containers.put("m4v");
        containers.put("mov");
        containers.put("webm");
        containers.put("mkv");

        // Per-codec max decodable resolution, so the backend refuses Direct
        // Play of a source above the device's real decode ceiling.
        JSObject resolutions = new JSObject();
        for (Map.Entry<String, int[]> e : maxRes.entrySet()) {
            JSObject wh = new JSObject();
            wh.put("width", e.getValue()[0]);
            wh.put("height", e.getValue()[1]);
            resolutions.put(e.getKey(), wh);
        }

        JSObject result = new JSObject();
        result.put("videoCodecs", arr);
        result.put("hevcMain10", hevcMain10);
        result.put("av1Main10", av1Main10);
        result.put("containers", containers);
        result.put("resolutions", resolutions);
        call.resolve(result);
    }

    /** True when the decoder advertises a 10-bit (Main10) or HDR profile. */
    private static boolean supportsMain10(MediaCodecInfo.CodecCapabilities caps, boolean hevc) {
        if (caps == null || caps.profileLevels == null) return false;
        for (MediaCodecInfo.CodecProfileLevel pl : caps.profileLevels) {
            if (hevc) {
                // HEVCProfileMain10 = 2, plus HDR10 / HDR10Plus variants.
                if (pl.profile == MediaCodecInfo.CodecProfileLevel.HEVCProfileMain10
                        || pl.profile == 0x1000
                        || pl.profile == 0x2000) {
                    return true;
                }
            } else {
                // AV1ProfileMain10 = 2, plus HDR10 / HDR10Plus variants.
                if (pl.profile == 2 || pl.profile == 0x1000 || pl.profile == 0x2000
                        || pl.profile == 0x4000) {
                    return true;
                }
            }
        }
        return false;
    }

    private static String mimeToCodecKey(String mime) {
        switch (mime.toLowerCase()) {
            case "video/avc":            return "h264";
            case "video/hevc":           return "hevc";
            case "video/av01":           return "av1";
            case "video/x-vnd.on2.vp9":  return "vp9";
            case "video/x-vnd.on2.vp8":  return "vp8";
            default: return null;
        }
    }
}
