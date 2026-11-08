package media.fliks.app;

import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.audio.AudioProcessor;
import androidx.media3.common.audio.BaseAudioProcessor;
import androidx.media3.common.util.UnstableApi;

import java.nio.ByteBuffer;

/** Scales PCM by the ReplayGain factor of the playing track; the factor is set on track change. */
@OptIn(markerClass = UnstableApi.class)
final class AudioGainProcessor extends BaseAudioProcessor {
    private volatile float factor = 1f;

    void setFactor(float factor) {
        this.factor = factor;
    }

    @Override
    protected AudioFormat onConfigure(AudioFormat input) throws UnhandledAudioFormatException {
        if (input.encoding != C.ENCODING_PCM_16BIT && input.encoding != C.ENCODING_PCM_FLOAT) {
            throw new UnhandledAudioFormatException(input);
        }
        return input;
    }

    @Override
    public void queueInput(ByteBuffer input) {
        ByteBuffer out = replaceOutputBuffer(input.remaining());
        float f = factor;
        if (inputAudioFormat.encoding == C.ENCODING_PCM_FLOAT) {
            while (input.remaining() >= 4) out.putFloat(Math.max(-1f, Math.min(1f, input.getFloat() * f)));
        } else {
            while (input.remaining() >= 2) {
                int v = Math.round(input.getShort() * f);
                out.putShort((short) Math.max(Short.MIN_VALUE, Math.min(Short.MAX_VALUE, v)));
            }
        }
        out.flip();
    }
}
