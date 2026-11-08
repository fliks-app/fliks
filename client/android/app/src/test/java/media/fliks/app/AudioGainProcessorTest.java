package media.fliks.app;

import static org.junit.Assert.assertEquals;

import androidx.media3.common.C;
import androidx.media3.common.audio.AudioProcessor;

import org.junit.Test;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;

public class AudioGainProcessorTest {
    private static ByteBuffer run(AudioGainProcessor p, int encoding, float factor, ByteBuffer in) throws Exception {
        p.configure(new AudioProcessor.AudioFormat(44100, 2, encoding));
        p.setFactor(factor);
        p.flush();
        p.queueInput(in);
        return p.getOutput();
    }

    @Test
    public void scalesAndClampsPcm16() throws Exception {
        ByteBuffer in = ByteBuffer.allocate(4).order(ByteOrder.nativeOrder());
        in.putShort((short) 1000).putShort((short) 30000).flip();
        ByteBuffer out = run(new AudioGainProcessor(), C.ENCODING_PCM_16BIT, 2f, in);
        assertEquals(2000, out.getShort());
        assertEquals(Short.MAX_VALUE, out.getShort());
    }

    @Test
    public void scalesFloat() throws Exception {
        ByteBuffer in = ByteBuffer.allocate(8).order(ByteOrder.nativeOrder());
        in.putFloat(0.5f).putFloat(-0.8f).flip();
        ByteBuffer out = run(new AudioGainProcessor(), C.ENCODING_PCM_FLOAT, 0.5f, in);
        assertEquals(0.25f, out.getFloat(), 1e-6);
        assertEquals(-0.4f, out.getFloat(), 1e-6);
    }
}
