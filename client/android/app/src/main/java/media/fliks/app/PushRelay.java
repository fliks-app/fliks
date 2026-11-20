package media.fliks.app;

import android.content.Context;
import android.content.pm.ApplicationInfo;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/** The relays this build talks to, the tickets it accepts and the two device calls of the relay protocol. */
final class PushRelay {
    /** The official relay, the server's default too. */
    static final String OFFICIAL = "https://push-relay.fliks.media";
    private static final String DEBUG_RELAY = "http://localhost:8080";

    private PushRelay() {}

    static List<String> urls(Context ctx) {
        List<String> urls = new ArrayList<>();
        urls.add(OFFICIAL);
        if ((ctx.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) urls.add(DEBUG_RELAY);
        return urls;
    }

    /** The decoded part of a relay ticket; the relay checks the signature. */
    static final class Ticket {
        final String key;
        final String sub;
        final String aud;

        Ticket(String key, String sub, String aud) {
            this.key = key;
            this.sub = sub;
            this.aud = aud;
        }
    }

    static Ticket parse(String ticket) throws JSONException {
        int dot = ticket.indexOf('.');
        if (dot <= 0) throw new JSONException("malformed ticket");
        byte[] json = B64.decode(ticket.substring(0, dot));
        JSONObject o = new JSONObject(new String(json, StandardCharsets.UTF_8));
        return new Ticket(o.getString("key"), o.getString("sub"), o.getString("aud"));
    }

    /** Canonical host as the relay signs it: host, plus the port when the URL names one. */
    static String canonicalHost(String url) {
        URI u = URI.create(url);
        return u.getPort() == -1 ? u.getHost() : u.getHost() + ":" + u.getPort();
    }

    /** The compiled-in relay a ticket is addressed to, null for any other audience. */
    static String forAudience(List<String> urls, String aud) {
        for (String url : urls) if (canonicalHost(url).equals(aud)) return url;
        return null;
    }

    static final class HttpStatus extends IOException {
        final int status;

        HttpStatus(int status) {
            super("relay " + status);
            this.status = status;
        }
    }

    static void put(String relay, String ticket, String token) throws IOException {
        try {
            call(relay, "PUT", new JSONObject().put("ticket", ticket).put("platform", "fcm").put("token", token));
        } catch (JSONException e) {
            throw new IOException(e);
        }
    }

    /** Deletes the rows of this token (and sub) at the relay; also succeeds when none matched. */
    static void delete(String relay, String token, String sub) throws IOException {
        try {
            call(relay, "DELETE", new JSONObject().put("platform", "fcm").put("token", token).put("sub", sub));
        } catch (HttpStatus e) {
            if (!gone(e.status)) throw e;
        } catch (JSONException e) {
            throw new IOException(e);
        }
    }

    /** A delete the relay answers with 400 or 404 will never succeed: the row is as good as gone. */
    static boolean gone(int status) {
        return status == 400 || status == 404;
    }

    private static void call(String relay, String method, JSONObject body) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(relay + "/v1/subscriptions").openConnection();
        try {
            c.setRequestMethod(method);
            c.setConnectTimeout(10_000);
            c.setReadTimeout(15_000);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            try (OutputStream out = c.getOutputStream()) {
                out.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            int status = c.getResponseCode();
            if (status >= 300) throw new HttpStatus(status);
        } finally {
            c.disconnect();
        }
    }
}
