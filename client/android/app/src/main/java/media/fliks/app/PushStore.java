package media.fliks.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.List;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** One record per session key (`serverUrl|userId`): its key pair, auth secret, subscription and relay state.
 *  The private scalar is wrapped by an AndroidKeyStore AES key; the file is excluded from backups. */
final class PushStore {
    private static final String PREFS = "fliks_push";
    private static final String WRAP_ALIAS = "fliks_push_wrap";
    private static final String SEEN = "seen";

    private final SharedPreferences prefs;

    PushStore(Context ctx) {
        prefs = ctx.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static String sessionKey(String serverUrl, int userId) {
        return serverUrl + "|" + userId;
    }

    @Nullable
    synchronized JSONObject get(String session) {
        return read("s:" + session);
    }

    synchronized List<JSONObject> all() {
        List<JSONObject> out = new ArrayList<>();
        for (String k : prefs.getAll().keySet()) {
            if (!k.startsWith("s:")) continue;
            JSONObject o = read(k);
            if (o != null) out.add(o);
        }
        return out;
    }

    @Nullable
    synchronized JSONObject bySub(String sub) {
        for (JSONObject o : all()) if (sub.equals(o.optString("sub"))) return o;
        return null;
    }

    synchronized void put(JSONObject entry) {
        prefs.edit().putString("s:" + entry.optString("session"), entry.toString()).apply();
    }

    synchronized void remove(String session) {
        prefs.edit().remove("s:" + session).apply();
    }

    @Nullable
    private JSONObject read(String key) {
        try {
            String raw = prefs.getString(key, null);
            return raw == null ? null : new JSONObject(raw);
        } catch (JSONException e) {
            return null;
        }
    }

    /** Ids of the last notifications shown, oldest first. */
    synchronized List<String> seen() {
        List<String> ids = new ArrayList<>();
        try {
            JSONArray a = new JSONArray(prefs.getString(SEEN, "[]"));
            for (int i = 0; i < a.length(); i++) ids.add(a.getString(i));
        } catch (JSONException ignored) {
            // A malformed ring reads as empty.
        }
        return ids;
    }

    /** False when `id` was already seen (a replay); else records it. */
    synchronized boolean markSeen(String id) {
        List<String> next = PushRules.remember(seen(), id);
        if (next == null) return false;
        prefs.edit().putString(SEEN, new JSONArray(next).toString()).apply();
        return true;
    }

    String wrap(byte[] secret) throws GeneralSecurityException {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, wrapKey());
        byte[] ct = c.doFinal(secret);
        byte[] iv = c.getIV();
        byte[] out = new byte[iv.length + ct.length];
        System.arraycopy(iv, 0, out, 0, iv.length);
        System.arraycopy(ct, 0, out, iv.length, ct.length);
        return B64.encode(out);
    }

    byte[] unwrap(String wrapped) throws GeneralSecurityException {
        byte[] in = B64.decode(wrapped);
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, wrapKey(), new GCMParameterSpec(128, in, 0, 12));
        return c.doFinal(in, 12, in.length - 12);
    }

    private static SecretKey wrapKey() throws GeneralSecurityException {
        try {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            if (ks.containsAlias(WRAP_ALIAS)) return (SecretKey) ks.getKey(WRAP_ALIAS, null);
            KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            g.init(new KeyGenParameterSpec.Builder(WRAP_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
            return g.generateKey();
        } catch (java.io.IOException e) {
            throw new GeneralSecurityException(e);
        }
    }
}
