package media.fliks.app;

import android.media.MediaCodecInfo;
import android.media.MediaCodecList;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.HashSet;
import java.util.Set;

/**
 * Reports the audio codecs the device's MediaCodec stack actually has a
 * decoder for. This is the only signal ExoPlayer reliably acts on — the
 * AudioCapabilities passthrough list can falsely include E-AC-3 on
 * devices without a decoder, and ExoPlayer then fails MediaCodec init.
 *
 * Output channel max is left to the playback stack to decide; we just
 * report whether there's a decoder, not the route topology.
 */
@CapacitorPlugin(name = "AudioCapabilities")
public class AudioCapabilitiesPlugin extends Plugin {

    @PluginMethod()
    public void getSupported(PluginCall call) {
        Set<String> codecs = new HashSet<>();
        // Real DECODE capability per codec (MediaCodec getMaxInputChannelCount):
        // ExoPlayer decodes up to this and the OS downmixes to whatever the
        // active output renders, so reporting it lets a 5.1/7.1 source
        // DirectPlay instead of a server-side downmix. Per-codec, because a
        // device may decode AAC 7.1 but EAC-3 only 5.1. Falls back to stereo
        // when no decoder reports a channel count.
        int maxChannels = 2;
        JSObject channelsByCodec = new JSObject();
        try {
            MediaCodecList list = new MediaCodecList(MediaCodecList.REGULAR_CODECS);
            for (MediaCodecInfo info : list.getCodecInfos()) {
                if (info.isEncoder()) continue;
                for (String type : info.getSupportedTypes()) {
                    String key = mimeToCodecKey(type);
                    if (key == null) continue;
                    codecs.add(key);
                    try {
                        MediaCodecInfo.AudioCapabilities ac =
                            info.getCapabilitiesForType(type).getAudioCapabilities();
                        if (ac != null) {
                            int ch = ac.getMaxInputChannelCount();
                            maxChannels = Math.max(maxChannels, ch);
                            // Largest across decoders of the same codec.
                            if (ch > channelsByCodec.optInt(key, 0)) {
                                channelsByCodec.put(key, ch);
                            }
                        }
                    } catch (Throwable ignored) { /* decoder omits audio caps */ }
                }
            }
        } catch (Throwable ignored) { /* best-effort */ }

        JSArray arr = new JSArray();
        for (String c : codecs) arr.put(c);
        JSObject result = new JSObject();
        result.put("codecs", arr);
        result.put("maxChannels", maxChannels);
        result.put("channelsByCodec", channelsByCodec);
        call.resolve(result);
    }

    private static String mimeToCodecKey(String mime) {
        switch (mime.toLowerCase()) {
            case "audio/mp4a-latm": return "aac";
            case "audio/mpeg":      return "mp3";
            case "audio/ac3":       return "ac3";
            case "audio/eac3":
            case "audio/eac3-joc":  return "eac3";
            case "audio/opus":      return "opus";
            case "audio/flac":      return "flac";
            case "audio/alac":      return "alac";
            case "audio/vnd.dts":
            case "audio/vnd.dts.hd": return "dts";
            case "audio/vorbis":    return "vorbis";
            default: return null;
        }
    }
}
