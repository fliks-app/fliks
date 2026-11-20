package media.fliks.app;

import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.AlgorithmParameters;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.interfaces.ECPrivateKey;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPrivateKeySpec;
import java.security.spec.ECPublicKeySpec;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/** RFC 8291 `aes128gcm` decryption and the P-256 key pair of a subscription, on plain JCA. */
final class PushCrypto {
    private static final int POINT = 65;
    private static final int HEADER = 16 + 4 + 1;

    private PushCrypto() {}

    /** Raw private scalar (32 bytes) and uncompressed public point (65 bytes). */
    static final class Keys {
        final byte[] priv;
        final byte[] pub;

        Keys(byte[] priv, byte[] pub) {
            this.priv = priv;
            this.pub = pub;
        }
    }

    private static ECParameterSpec curve() throws GeneralSecurityException {
        AlgorithmParameters p = AlgorithmParameters.getInstance("EC");
        p.init(new ECGenParameterSpec("secp256r1"));
        return p.getParameterSpec(ECParameterSpec.class);
    }

    static Keys generate() throws GeneralSecurityException {
        KeyPairGenerator g = KeyPairGenerator.getInstance("EC");
        g.initialize(new ECGenParameterSpec("secp256r1"));
        KeyPair kp = g.generateKeyPair();
        ECPoint w = ((ECPublicKey) kp.getPublic()).getW();
        byte[] pub = new byte[POINT];
        pub[0] = 4;
        System.arraycopy(fixed(w.getAffineX()), 0, pub, 1, 32);
        System.arraycopy(fixed(w.getAffineY()), 0, pub, 33, 32);
        return new Keys(fixed(((ECPrivateKey) kp.getPrivate()).getS()), pub);
    }

    private static byte[] fixed(BigInteger v) {
        byte[] raw = v.toByteArray();
        byte[] out = new byte[32];
        int n = Math.min(raw.length, 32);
        System.arraycopy(raw, raw.length - n, out, 32 - n, n);
        return out;
    }

    /** The plaintext of one `aes128gcm` record addressed to the key pair `keys` and the secret `auth`. */
    static byte[] decrypt(byte[] message, Keys keys, byte[] auth) throws GeneralSecurityException {
        if (message.length < HEADER + POINT + 17) throw new GeneralSecurityException("short message");
        ByteBuffer b = ByteBuffer.wrap(message);
        byte[] salt = new byte[16];
        b.get(salt);
        long rs = b.getInt() & 0xffffffffL;
        int idLen = b.get() & 0xff;
        if (idLen != POINT || message.length < HEADER + idLen + 17) throw new GeneralSecurityException("bad header");
        byte[] sender = new byte[idLen];
        b.get(sender);
        byte[] cipherText = new byte[b.remaining()];
        b.get(cipherText);
        if (rs < 18 || cipherText.length > rs) throw new GeneralSecurityException("not a single record");

        ECParameterSpec spec = curve();
        KeyFactory kf = KeyFactory.getInstance("EC");
        ECPrivateKey priv = (ECPrivateKey) kf.generatePrivate(new ECPrivateKeySpec(new BigInteger(1, keys.priv), spec));
        ECPoint point = new ECPoint(new BigInteger(1, Arrays.copyOfRange(sender, 1, 33)), new BigInteger(1, Arrays.copyOfRange(sender, 33, 65)));
        ECPublicKey pub = (ECPublicKey) kf.generatePublic(new ECPublicKeySpec(point, spec));
        KeyAgreement ka = KeyAgreement.getInstance("ECDH");
        ka.init(priv);
        ka.doPhase(pub, true);
        byte[] secret = ka.generateSecret();

        byte[] keyInfo = concat("WebPush: info\0".getBytes(StandardCharsets.US_ASCII), keys.pub, sender);
        byte[] ikm = expand(extract(auth, secret), keyInfo, 32);
        byte[] prk = extract(salt, ikm);
        byte[] cek = expand(prk, "Content-Encoding: aes128gcm\0".getBytes(StandardCharsets.US_ASCII), 16);
        byte[] nonce = expand(prk, "Content-Encoding: nonce\0".getBytes(StandardCharsets.US_ASCII), 12);

        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(cek, "AES"), new GCMParameterSpec(128, nonce));
        byte[] padded = c.doFinal(cipherText);
        int end = padded.length;
        while (end > 0 && padded[end - 1] == 0) end--;
        if (end == 0 || padded[end - 1] != 2) throw new GeneralSecurityException("bad padding");
        return Arrays.copyOf(padded, end - 1);
    }

    private static byte[] extract(byte[] salt, byte[] ikm) throws GeneralSecurityException {
        Mac m = Mac.getInstance("HmacSHA256");
        m.init(new SecretKeySpec(salt, "HmacSHA256"));
        return m.doFinal(ikm);
    }

    /** One HKDF block, enough for every key of the scheme (at most 32 bytes). */
    private static byte[] expand(byte[] prk, byte[] info, int len) throws GeneralSecurityException {
        Mac m = Mac.getInstance("HmacSHA256");
        m.init(new SecretKeySpec(prk, "HmacSHA256"));
        m.update(info);
        return Arrays.copyOf(m.doFinal(new byte[] {1}), len);
    }

    private static byte[] concat(byte[]... parts) {
        int n = 0;
        for (byte[] p : parts) n += p.length;
        byte[] out = new byte[n];
        int at = 0;
        for (byte[] p : parts) {
            System.arraycopy(p, 0, out, at, p.length);
            at += p.length;
        }
        return out;
    }
}
