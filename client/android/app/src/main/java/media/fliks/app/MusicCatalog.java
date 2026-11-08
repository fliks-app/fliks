package media.fliks.app;

import android.content.Context;
import android.net.Uri;
import android.os.Bundle;

import androidx.annotation.Nullable;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** The music of the fliks API as a MediaLibrary tree and as queue items; ids are
 *  `root`, a section, `album:<id>`, `playlist:<id>`, `artist:<id>` or `<parent>|<trackItemId>`. */
final class MusicCatalog {
    static final String ROOT = "root";
    static final String RECENT = "recent";
    static final String FAVOURITES = "favourites";
    static final String PLAYLISTS = "playlists";
    static final String ALBUMS = "albums";
    static final String ARTISTS = "artists";
    static final String SEARCH = "search";
    static final String SCHEME = "fliks-track";

    private static final String GROUP_TITLE = "android.media.browse.CONTENT_STYLE_GROUP_TITLE_HINT";

    static final String X_ITEM = "fliks.itemId";
    static final String X_MEDIA = "fliks.mediaId";
    static final String X_GAIN = "fliks.gain";
    static final String X_PEAK = "fliks.peak";
    static final String X_ALBUM_GAIN = "fliks.albumGain";
    static final String X_ALBUM_PEAK = "fliks.albumPeak";

    /** What a play request expands to: the queue and where it starts. */
    static final class Queue {
        final List<MediaItem> items;
        final int start;

        Queue(List<MediaItem> items, int start) {
            this.items = items;
            this.start = start;
        }
    }

    private final FliksApi api;
    private final Context context;
    /** Tracks of search results, which have no parent to expand from. */
    private final Map<String, MediaItem> seen = new ConcurrentHashMap<>();

    MusicCatalog(Context context, FliksApi api) {
        this.context = context;
        this.api = api;
    }

    boolean isTrackRequest(String mediaId) {
        return mediaId.indexOf('|') > 0;
    }

    MediaItem root() {
        return folder(ROOT, context.getString(R.string.auto_root), null, null, MediaMetadata.MEDIA_TYPE_FOLDER_MIXED);
    }

    @Nullable
    MediaItem item(String id) throws IOException, JSONException {
        switch (id) {
            case ROOT:
                return root();
            case RECENT:
            case FAVOURITES:
            case PLAYLISTS:
            case ALBUMS:
            case ARTISTS:
                return section(id);
            default:
        }
        if (id.startsWith("album:")) {
            JSONObject m = api.getJson("/api/media/" + id.substring(6));
            return folder(id, m.optString("title"), artists(m.optJSONObject("album")), url(m, "posterUrl"),
                    MediaMetadata.MEDIA_TYPE_ALBUM);
        }
        if (id.indexOf('|') > 0) {
            long item = Long.parseLong(id.substring(id.indexOf('|') + 1));
            for (MediaItem t : expand(id).items) {
                if (t.mediaMetadata.extras != null && t.mediaMetadata.extras.getLong(X_ITEM) == item) return t;
            }
        }
        return null;
    }

    private MediaItem section(String id) {
        int label;
        switch (id) {
            case RECENT: label = R.string.auto_recent; break;
            case FAVOURITES: label = R.string.auto_favourites; break;
            case PLAYLISTS: label = R.string.auto_playlists; break;
            case ALBUMS: label = R.string.auto_albums; break;
            default: label = R.string.auto_artists;
        }
        return folder(id, context.getString(label), null, null, MediaMetadata.MEDIA_TYPE_FOLDER_MIXED);
    }

    /** One page of a folder; `page` is 0-based. */
    List<MediaItem> children(String parent, int page, int size) throws IOException, JSONException {
        int api1 = page + 1;
        int limit = Math.min(size, 200);
        List<MediaItem> out = new ArrayList<>();
        switch (parent) {
            case ROOT:
                for (String s : new String[]{RECENT, FAVOURITES, PLAYLISTS, ALBUMS, ARTISTS}) out.add(section(s));
                return out;
            case RECENT:
                if (page > 0) return out;
                albums(out, api.getArray("/api/playback/recently-played?limit=" + limit));
                return out;
            case FAVOURITES:
                tracks(out, api.getArray("/api/tracks?favourite=true&sortBy=added&sortOrder=desc&limit=" + limit
                        + "&page=" + api1), FAVOURITES);
                return out;
            case PLAYLISTS:
                if (page > 0) return out;
                JSONArray lists = api.getArray("/api/playlists");
                for (int i = 0; i < lists.length(); i++) {
                    JSONObject p = lists.getJSONObject(i);
                    out.add(folder("playlist:" + p.getInt("id"), p.optString("name"), null,
                            url(p, "coverImageUrl"), MediaMetadata.MEDIA_TYPE_PLAYLIST));
                }
                return out;
            case ALBUMS:
                albums(out, api.getJson("/api/media?type=album&sortBy=title&sortOrder=asc&limit=" + limit
                        + "&page=" + api1).getJSONArray("data"));
                return out;
            case ARTISTS:
                JSONArray people = api.getArray("/api/persons?role=artist&limit=" + limit + "&page=" + api1);
                for (int i = 0; i < people.length(); i++) {
                    JSONObject p = people.getJSONObject(i);
                    out.add(folder("artist:" + p.getInt("id"), p.optString("name"), null,
                            url(p, "avatarUrl"), MediaMetadata.MEDIA_TYPE_ARTIST));
                }
                return out;
            default:
        }
        if (parent.startsWith("artist:")) {
            if (page > 0) return out;
            JSONArray owned = api.getJson("/api/persons/" + parent.substring(7) + "/discography").getJSONArray("albums");
            for (int i = 0; i < owned.length(); i++) {
                JSONObject a = owned.getJSONObject(i);
                if (!a.optBoolean("owned") || a.isNull("mediaId")) continue;
                out.add(folder("album:" + a.getInt("mediaId"), a.optString("title"), null,
                        url(a, "posterUrl"), MediaMetadata.MEDIA_TYPE_ALBUM));
            }
            return out;
        }
        if (page > 0) return out;
        out.addAll(expand(parent).items);
        return out;
    }

    List<MediaItem> search(String query) throws IOException, JSONException {
        List<MediaItem> out = new ArrayList<>();
        String q = Uri.encode(query);
        albums(out, api.getJson("/api/media?type=album&limit=10&q=" + q).getJSONArray("data"));
        int albums = out.size();
        tracks(out, api.getArray("/api/tracks?limit=30&q=" + q), SEARCH);
        for (int i = 0; i < out.size(); i++) {
            out.set(i, grouped(out.get(i), context.getString(i < albums ? R.string.auto_albums : R.string.auto_tracks)));
        }
        return out;
    }

    /** A folder or a `<parent>|<track>` request as a queue; a bare track plays alone. */
    Queue expand(String id) throws IOException, JSONException {
        String parent = id;
        long wanted = -1;
        int bar = id.indexOf('|');
        if (bar > 0) {
            parent = id.substring(0, bar);
            wanted = Long.parseLong(id.substring(bar + 1));
        }
        List<MediaItem> items = new ArrayList<>();
        if (parent.startsWith("album:")) {
            JSONObject m = api.getJson("/api/media/" + parent.substring(6));
            JSONObject album = m.getJSONObject("album");
            int edition = album.isNull("targetEditionId") ? -1 : album.getInt("targetEditionId");
            JSONArray editions = album.getJSONArray("editions");
            double albumGain = Double.NaN;
            double albumPeak = Double.NaN;
            for (int i = 0; i < editions.length(); i++) {
                JSONObject e = editions.getJSONObject(i);
                if (edition < 0 && e.optBoolean("hasFiles")) edition = e.getInt("id");
                if (e.getInt("id") == edition) {
                    albumGain = e.isNull("albumGain") ? Double.NaN : e.getDouble("albumGain");
                    albumPeak = e.isNull("albumPeak") ? Double.NaN : e.getDouble("albumPeak");
                }
            }
            JSONArray tracks = album.getJSONArray("tracks");
            String cover = url(m, "posterUrl");
            boolean discs = false;
            for (int i = 0; i < tracks.length(); i++) discs |= tracks.getJSONObject(i).optInt("discNumber", 1) > 1;
            for (int i = 0; i < tracks.length(); i++) {
                JSONObject t = tracks.getJSONObject(i);
                if (t.getInt("editionId") != edition || !t.optBoolean("hasFile")) continue;
                String by = artists(t, album);
                MediaItem item = track(parent, t.getLong("itemId"), m.getLong("id"), t.optString("title"), by,
                        m.optString("title"), cover, optDouble(t, "durationSeconds"), optDouble(t, "gain"),
                        optDouble(t, "peak"), albumGain, albumPeak);
                if (discs) {
                    String name = t.isNull("discTitle") ? "" : t.optString("discTitle");
                    item = grouped(item, name.isEmpty()
                            ? context.getString(R.string.auto_disc, t.optInt("discNumber", 1)) : name);
                }
                items.add(item);
            }
        } else if (parent.startsWith("playlist:")) {
            JSONArray entries = api.getArray("/api/playlists/" + parent.substring(9) + "/items");
            for (int i = 0; i < entries.length(); i++) {
                JSONObject t = entries.getJSONObject(i).optJSONObject("track");
                if (t == null || t.isNull("mediaFileId")) continue;
                JSONArray names = t.optJSONArray("artists");
                List<String> parts = new ArrayList<>();
                for (int j = 0; names != null && j < names.length(); j++) parts.add(names.getString(j));
                items.add(track(parent, t.getLong("itemId"), t.getLong("mediaId"), t.optString("title"),
                        String.join(", ", parts), t.optString("albumTitle"), url(t, "posterUrl"),
                        optDouble(t, "durationSeconds"), Double.NaN, Double.NaN, Double.NaN, Double.NaN));
            }
        } else if (FAVOURITES.equals(parent)) {
            tracks(items, api.getArray("/api/tracks?favourite=true&sortBy=added&sortOrder=desc&limit=200"), parent);
        } else if (seen.containsKey(id)) {
            items.add(seen.get(id));
        }
        int start = 0;
        for (int i = 0; i < items.size(); i++) {
            Bundle x = items.get(i).mediaMetadata.extras;
            if (wanted >= 0 && x != null && x.getLong(X_ITEM) == wanted) start = i;
        }
        return new Queue(items, start);
    }

    /** The playable queue entry: the URI is resolved to a stream when it loads. */
    static MediaItem queueItem(long itemId, long mediaId, String title, String artist, String album,
                               @Nullable String artwork, double duration, double gain, double peak,
                               double albumGain, double albumPeak) {
        Bundle x = new Bundle();
        x.putLong(X_ITEM, itemId);
        x.putLong(X_MEDIA, mediaId);
        x.putDouble(X_GAIN, gain);
        x.putDouble(X_PEAK, peak);
        x.putDouble(X_ALBUM_GAIN, albumGain);
        x.putDouble(X_ALBUM_PEAK, albumPeak);
        MediaMetadata.Builder md = new MediaMetadata.Builder()
                .setTitle(title).setArtist(artist).setAlbumTitle(album)
                .setIsBrowsable(false).setIsPlayable(true)
                .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
                .setExtras(x);
        if (artwork != null) md.setArtworkUri(Uri.parse(artwork));
        if (!Double.isNaN(duration)) md.setDurationMs((long) (duration * 1000));
        return new MediaItem.Builder()
                .setMediaId("t:" + itemId)
                .setUri(SCHEME + "://" + itemId)
                .setMediaMetadata(md.build())
                .build();
    }

    private MediaItem track(String parent, long itemId, long mediaId, String title, String artist, String album,
                            @Nullable String cover, double duration, double gain, double peak, double albumGain,
                            double albumPeak) {
        MediaItem q = queueItem(itemId, mediaId, title, artist, album, cover == null ? null : api.absolute(cover),
                duration, gain, peak, albumGain, albumPeak);
        MediaItem item = q.buildUpon().setMediaId(parent + "|" + itemId).build();
        if (SEARCH.equals(parent)) seen.put(item.mediaId, item);
        return item;
    }

    private void tracks(List<MediaItem> out, JSONArray rows, String parent) throws JSONException {
        for (int i = 0; i < rows.length(); i++) {
            JSONObject t = rows.getJSONObject(i);
            if (!t.optBoolean("hasFile", true)) continue;
            out.add(track(parent, t.getLong("itemId"), t.getLong("mediaId"), t.optString("title"), artists(t, null),
                    t.optString("albumTitle"), url(t, "posterUrl"), optDouble(t, "durationSeconds"),
                    optDouble(t, "gain"), optDouble(t, "peak"), Double.NaN, Double.NaN));
        }
    }

    private void albums(List<MediaItem> out, JSONArray rows) throws JSONException {
        for (int i = 0; i < rows.length(); i++) {
            JSONObject m = rows.getJSONObject(i);
            out.add(folder("album:" + m.getInt("id"), m.optString("title"), artists(m.optJSONObject("album")),
                    url(m, "posterUrl"), MediaMetadata.MEDIA_TYPE_ALBUM));
        }
    }

    private static MediaItem grouped(MediaItem item, String title) {
        Bundle x = item.mediaMetadata.extras == null ? new Bundle() : new Bundle(item.mediaMetadata.extras);
        x.putString(GROUP_TITLE, title);
        return item.buildUpon().setMediaMetadata(item.mediaMetadata.buildUpon().setExtras(x).build()).build();
    }

    private MediaItem folder(String id, String title, @Nullable String subtitle, @Nullable String art, int type) {
        MediaMetadata.Builder md = new MediaMetadata.Builder()
                .setTitle(title).setIsBrowsable(true).setIsPlayable(false).setMediaType(type);
        if (subtitle != null && !subtitle.isEmpty()) md.setSubtitle(subtitle);
        if (art != null && !art.isEmpty() && !"null".equals(art)) md.setArtworkUri(Uri.parse(api.absolute(art)));
        return new MediaItem.Builder().setMediaId(id).setMediaMetadata(md.build()).build();
    }

    private static String artists(@Nullable JSONObject album) {
        JSONArray list = album == null ? null : album.optJSONArray("artists");
        StringBuilder sb = new StringBuilder();
        for (int i = 0; list != null && i < list.length(); i++) {
            JSONObject a = list.optJSONObject(i);
            if (a == null) continue;
            String name = a.optString("creditedName", "");
            sb.append(name.isEmpty() || "null".equals(name) ? a.optString("name") : name);
            String join = a.optString("joinPhrase", "");
            if (!join.isEmpty() && !"null".equals(join) && i < list.length() - 1) sb.append(join);
            else if (i < list.length() - 1) sb.append(", ");
        }
        return sb.toString();
    }

    private static String artists(JSONObject track, @Nullable JSONObject album) {
        JSONArray list = track.optJSONArray("artists");
        if (list == null || list.length() == 0) return artists(album);
        JSONObject wrap = new JSONObject();
        try {
            wrap.put("artists", list);
        } catch (JSONException e) {
            return "";
        }
        return artists(wrap);
    }

    /** A JSON null is no URL: `optString` would turn it into the text "null". */
    @Nullable
    private static String url(JSONObject o, String key) {
        return o.isNull(key) ? null : o.optString(key, null);
    }

    private static double optDouble(JSONObject o, String key) {
        return o.isNull(key) || !o.has(key) ? Double.NaN : o.optDouble(key, Double.NaN);
    }
}
