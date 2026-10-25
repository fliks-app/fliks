package media.fliks.app;

import android.graphics.Color;
import android.media.MediaCodecInfo;
import android.media.MediaCodecList;
import android.os.Build;
import android.widget.FrameLayout;
import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.audio.AudioCapabilities;
import androidx.media3.exoplayer.audio.AudioSink;
import androidx.media3.exoplayer.audio.DefaultAudioSink;
import android.content.Context;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/** Stateless helpers of {@link NativePlayerPlugin}. */
final class NativePlayerUtil {
    private NativePlayerUtil() {}

    private static final Map<String, Boolean> HW_DECODER_CACHE = new HashMap<>();

    @OptIn(markerClass = UnstableApi.class)
    static final class PcmOnlyRenderersFactory extends DefaultRenderersFactory {
        PcmOnlyRenderersFactory(Context context) { super(context); }

        @Override
        protected AudioSink buildAudioSink(Context context, boolean enableFloatOutput,
                boolean enableAudioTrackPlaybackParams) {
            // A context-less builder is required: with a context, media3 discards these capabilities.
            return new DefaultAudioSink.Builder()
                    .setAudioCapabilities(pcmPlusUndecodable(AudioCapabilities.getCapabilities(context)))
                    .setEnableFloatOutput(enableFloatOutput)
                    .setEnableAudioTrackPlaybackParams(enableAudioTrackPlaybackParams)
                    .build();
        }
    }

    /** PCM so volume works, plus the bitstreams no MediaCodec decodes (a mute gate cannot silence those). */
    @OptIn(markerClass = UnstableApi.class)
    static AudioCapabilities pcmPlusUndecodable(AudioCapabilities caps) {
        int[] wanted = {C.ENCODING_PCM_16BIT, C.ENCODING_DTS, C.ENCODING_DTS_HD, C.ENCODING_DTS_UHD_P2,
                C.ENCODING_DOLBY_TRUEHD};
        java.util.ArrayList<Integer> kept = new java.util.ArrayList<>();
        for (int e : wanted) if (e == C.ENCODING_PCM_16BIT || caps.supportsEncoding(e)) kept.add(e);
        int[] encodings = new int[kept.size()];
        for (int i = 0; i < encodings.length; i++) encodings[i] = kept.get(i);
        return new AudioCapabilities(encodings, caps.getMaxChannelCount());
    }

    static int parseColor(String hex, int fallback) {
        try {
            return Color.parseColor(hex);
        } catch (Exception e) {
            return fallback;
        }
    }

    static boolean sameParams(FrameLayout.LayoutParams a, FrameLayout.LayoutParams b) {
        return a.width == b.width && a.height == b.height
                && a.leftMargin == b.leftMargin && a.topMargin == b.topMargin && a.gravity == b.gravity;
    }

    static synchronized boolean isHardwareDecoder(String name) {
        Boolean cached = HW_DECODER_CACHE.get(name);
        if (cached != null) return cached;
        Boolean hw = null;
        if (Build.VERSION.SDK_INT >= 29) {
            for (MediaCodecInfo info : new MediaCodecList(MediaCodecList.ALL_CODECS).getCodecInfos()) {
                if (info.getName().equals(name)) { hw = info.isHardwareAccelerated(); break; }
            }
        }
        if (hw == null) {
            String n = name.toLowerCase(Locale.ROOT);
            hw = !(n.startsWith("omx.google.") || n.startsWith("c2.android.") || n.contains(".sw."));
        }
        HW_DECODER_CACHE.put(name, hw);
        return hw;
    }

    static Object orNull(Object v) {
        return v != null ? v : org.json.JSONObject.NULL;
    }


    /** Draws a bitmap (PGS/VOBSUB) cue near the bottom, aspect preserved (SubtitleView squishes bitmaps), sized from the video
     *  WIDTH to stay consistent across orientations; null hides it. */
    static boolean isImageSubtitleMime(String mime) {
        return MimeTypes.APPLICATION_PGS.equals(mime)
                || MimeTypes.APPLICATION_VOBSUB.equals(mime)
                || MimeTypes.APPLICATION_DVBSUBS.equals(mime);
    }


    /** Bitmap (burn-in-only) subtitle track: the modern pipeline rewrites sampleMimeType to media3 cues and keeps the
     *  original codec in `codecs`, so check both. */
    static boolean isImageSubtitle(androidx.media3.common.Format fmt) {
        return isImageSubtitleMime(fmt.sampleMimeType) || isImageSubtitleMime(fmt.codecs);
    }

    /** Convert ISO 639-2/B or 639-1 language code to display name. */
    static String langToDisplayName(String code) {
        if (code == null || code.equals("und")) return "Unknown";
        Locale loc = Locale.forLanguageTag(code);
        String name = loc.getDisplayLanguage(Locale.getDefault());
        if (!name.isEmpty() && !name.equals(code)) {
            return name.substring(0, 1).toUpperCase() + name.substring(1);
        }
        return code;
    }
}
