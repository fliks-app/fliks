package media.fliks.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;

public class PushCryptoTest {
    private static byte[] b64(String s) {
        return B64.decode(s);
    }

    // RFC 8291 appendix A.
    private static final PushCrypto.Keys UA = new PushCrypto.Keys(
        b64("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"),
        b64("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"));
    private static final byte[] AUTH = b64("BTBZMqHH6r4Tts7J_aSIgg");
    private static final String MESSAGE =
        "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQ"
        + "pu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";

    @Test
    public void decryptsTheRfcVector() throws Exception {
        byte[] plain = PushCrypto.decrypt(b64(MESSAGE), UA, AUTH);
        assertEquals("When I grow up, I want to be a watermelon", new String(plain, StandardCharsets.UTF_8));
    }

    @Test
    public void refusesAWrongAuthSecret() {
        byte[] auth = Arrays.copyOf(AUTH, AUTH.length);
        auth[0] ^= 1;
        assertThrows(GeneralSecurityException.class, () -> PushCrypto.decrypt(b64(MESSAGE), UA, auth));
    }

    @Test
    public void refusesATamperedMessage() {
        byte[] m = b64(MESSAGE);
        m[m.length - 1] ^= 1;
        assertThrows(GeneralSecurityException.class, () -> PushCrypto.decrypt(m, UA, AUTH));
    }

    @Test
    public void base64urlRoundTrips() {
        for (int n = 0; n < 8; n++) {
            byte[] in = new byte[n];
            for (int i = 0; i < n; i++) in[i] = (byte) (i * 91 + 200);
            assertArrayEquals(in, B64.decode(B64.encode(in)));
        }
        assertEquals("AQID", B64.encode(new byte[] {1, 2, 3}));
    }

    @Test
    public void generatedKeysHaveTheWireShape() throws Exception {
        PushCrypto.Keys k = PushCrypto.generate();
        assertEquals(32, k.priv.length);
        assertEquals(65, k.pub.length);
        assertEquals(4, k.pub[0]);
    }

    @Test
    public void parsesTheRelayTicketVector() throws Exception {
        String ticket = "eyJrZXkiOiJBNkVIdl9QT0VMNGRjTjBZNTB2QW1XZmsxakNicFExZkhkeUdaQkpWTWJnIiwic3ViIjoiRUJFU0V4UVZGaGNZR1JvYkhCMGVIdyIsImF1ZCI6InJlbGF5LmV4YW1wbGUudGVzdCIsImV4cCI6MTgwMDAwMDMwMH0.gN3cmHED9avZeXUGJHU3TqX0OuHQoAvnoseWXWcshE2HNstMu0BIAvNZ8EZmAMvwa77zS2WtER7hy1tfN_jGDQ";
        PushRelay.Ticket t = PushRelay.parse(ticket);
        assertEquals("A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg", t.key);
        assertEquals("EBESExQVFhcYGRobHB0eHw", t.sub);
        assertEquals("relay.example.test", t.aud);
        assertEquals("https://relay.example.test", PushRelay.forAudience(List.of("https://relay.example.test"), t.aud));
        assertNull(PushRelay.forAudience(List.of("https://relay.other.test"), t.aud));
        assertEquals("localhost:8080", PushRelay.canonicalHost("http://localhost:8080"));
    }

    @Test
    public void replayRules() {
        assertTrue(PushRules.expired(100, 50, 151));
        assertFalse(PushRules.expired(100, 50, 150));
        List<String> ids = new ArrayList<>();
        for (int i = 0; i < 205; i++) ids = PushRules.remember(ids, "id" + i);
        assertEquals(200, ids.size());
        assertEquals("id5", ids.get(0));
        assertNull(PushRules.remember(ids, "id204"));
        assertArrayEquals(new String[] {"id204"}, new String[] {ids.get(199)});
    }
}
