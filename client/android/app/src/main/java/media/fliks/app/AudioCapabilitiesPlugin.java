package media.fliks.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.media.MediaCodecInfo;
import android.media.MediaCodecList;
import android.os.Handler;
import android.os.Looper;

import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.audio.AudioCapabilities;

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
 * `passthrough` lists what the HDMI sink takes as a bitstream (the same
 * capabilities ExoPlayer's audio sink uses) and `audioRouteChanged` fires on
 * hot-plug; the client only advertises it on Android TV.
 *
 * Output channel max is left to the playback stack to decide; we just
 * report whether there's a decoder, not the route topology.
 */
@CapacitorPlugin(name = "AudioCapabilities")
@OptIn(markerClass = UnstableApi.class)
public class AudioCapabilitiesPlugin extends Plugin {
    private final BroadcastReceiver hdmiReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) { notifyRouteChanged(); }
    };
    private final AudioDeviceCallback deviceCallback = new AudioDeviceCallback() {
        @Override public void onAudioDevicesAdded(AudioDeviceInfo[] d) { notifyRouteChanged(); }
        @Override public void onAudioDevicesRemoved(AudioDeviceInfo[] d) { notifyRouteChanged(); }
    };

    @Override
    public void load() {
        Context ctx = getContext();
        ctx.registerReceiver(hdmiReceiver, new IntentFilter(AudioManager.ACTION_HDMI_AUDIO_PLUG));
        ((AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE))
            .registerAudioDeviceCallback(deviceCallback, new Handler(Looper.getMainLooper()));
    }

    @Override
    protected void handleOnDestroy() {
        Context ctx = getContext();
        ctx.unregisterReceiver(hdmiReceiver);
        ((AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE))
            .unregisterAudioDeviceCallback(deviceCallback);
    }

    private void notifyRouteChanged() {
        notifyListeners("audioRouteChanged", new JSObject());
    }

    /** Bitstream codecs the current output takes untouched, as profile codec keys. */
    static JSObject passthrough(Context context) {
        JSArray codecs = new JSArray();
        int maxChannels = 2;
        try {
            AudioCapabilities caps = AudioCapabilities.getCapabilities(context);
            if (caps.supportsEncoding(C.ENCODING_AC3)) codecs.put("ac3");
            if (caps.supportsEncoding(C.ENCODING_E_AC3) || caps.supportsEncoding(C.ENCODING_E_AC3_JOC)) codecs.put("eac3");
            if (caps.supportsEncoding(C.ENCODING_DTS) || caps.supportsEncoding(C.ENCODING_DTS_HD)
                    || caps.supportsEncoding(C.ENCODING_DTS_UHD_P2)) codecs.put("dts");
            if (caps.supportsEncoding(C.ENCODING_DOLBY_TRUEHD)) codecs.put("truehd");
            if (codecs.length() > 0) maxChannels = caps.getMaxChannelCount();
        } catch (Throwable ignored) { /* best-effort */ }
        JSObject r = new JSObject();
        r.put("codecs", codecs);
        r.put("maxChannels", maxChannels);
        return r;
    }

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
        result.put("passthrough", passthrough(getContext()));
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
