package media.fliks.app;

/** base64url without padding (java.util.Base64 needs API 26, the minimum is 23). */
final class B64 {
    private static final String ABC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

    private B64() {}

    static String encode(byte[] in) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < in.length; i += 3) {
            int n = (in[i] & 0xff) << 16 | (i + 1 < in.length ? (in[i + 1] & 0xff) << 8 : 0) | (i + 2 < in.length ? in[i + 2] & 0xff : 0);
            sb.append(ABC.charAt(n >> 18 & 63)).append(ABC.charAt(n >> 12 & 63));
            if (i + 1 < in.length) sb.append(ABC.charAt(n >> 6 & 63));
            if (i + 2 < in.length) sb.append(ABC.charAt(n & 63));
        }
        return sb.toString();
    }

    static byte[] decode(String s) {
        int full = s.length() / 4 * 3;
        int rest = s.length() % 4;
        if (rest == 1) throw new IllegalArgumentException("bad base64url length");
        byte[] out = new byte[full + (rest == 0 ? 0 : rest - 1)];
        int at = 0;
        for (int i = 0; i < s.length(); i += 4) {
            int n = 0;
            int chars = Math.min(4, s.length() - i);
            for (int j = 0; j < 4; j++) {
                int v = j < chars ? ABC.indexOf(s.charAt(i + j)) : 0;
                if (v < 0) throw new IllegalArgumentException("bad base64url");
                n = n << 6 | v;
            }
            for (int j = 0; j < chars - 1; j++) out[at++] = (byte) (n >> (16 - 8 * j));
        }
        return out;
    }
}
