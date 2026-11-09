package media.fliks.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

import org.json.JSONObject;
import org.junit.Test;

import java.util.Arrays;
import java.util.HashSet;

public class NativeAudioFormatsTest {
    @Test
    public void profileFollowsTheDecoders() throws Exception {
        JSONObject p = NativeAudioFormats.directPlay(new HashSet<>(Arrays.asList("audio/opus", "audio/mpeg")));
        assertEquals("[\"mp3\",\"ogg\",\"opus\"]", p.getJSONArray("containers").toString());
        assertEquals(2, p.getJSONArray("audioCodecs").length());
        assertFalse(p.getJSONArray("audioCodecs").toString().contains("flac"));
    }
}
