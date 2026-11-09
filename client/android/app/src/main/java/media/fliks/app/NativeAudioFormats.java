package media.fliks.app;

import android.media.MediaCodecInfo;
import android.media.MediaCodecList;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;

/** The audio files the device opens as they are, from its own decoders; the web layer sends them with the rest of the profile. */
final class NativeAudioFormats {
    private NativeAudioFormats() {}

    /** Decoder MIME types reported by the platform. */
    static Set<String> decoderMimes() {
        Set<String> mimes = new LinkedHashSet<>();
        for (MediaCodecInfo info : new MediaCodecList(MediaCodecList.REGULAR_CODECS).getCodecInfos()) {
            if (info.isEncoder()) continue;
            for (String type : info.getSupportedTypes()) mimes.add(type.toLowerCase(Locale.ROOT));
        }
        return mimes;
    }

    /** A direct-play profile for the containers Media3 reads whose codec a decoder reports. */
    static JSONObject directPlay(Set<String> mimes) throws JSONException {
        Set<String> containers = new LinkedHashSet<>();
        Set<String> codecs = new LinkedHashSet<>();
        add(mimes, "audio/mpeg", "mp3", new String[]{"mp3"}, containers, codecs);
        add(mimes, "audio/mp4a-latm", "aac", new String[]{"aac", "mp4"}, containers, codecs);
        add(mimes, "audio/alac", "alac", new String[]{"mp4"}, containers, codecs);
        add(mimes, "audio/flac", "flac", new String[]{"flac"}, containers, codecs);
        add(mimes, "audio/opus", "opus", new String[]{"ogg", "opus"}, containers, codecs);
        add(mimes, "audio/vorbis", "vorbis", new String[]{"ogg"}, containers, codecs);
        if (mimes.contains("audio/raw")) {
            containers.add("wav");
            codecs.add("pcm_s16le");
            codecs.add("pcm_s24le");
        }
        return new JSONObject().put("containers", new JSONArray(containers))
                .put("videoCodecs", new JSONArray()).put("audioCodecs", new JSONArray(codecs));
    }

    private static void add(Set<String> mimes, String mime, String codec, String[] fileContainers,
                            Set<String> containers, Set<String> codecs) {
        if (!mimes.contains(mime)) return;
        codecs.add(codec);
        for (String c : fileContainers) containers.add(c);
    }
}
