package media.fliks.app;

import com.getcapacitor.JSObject;
import com.google.android.gms.cast.TextTrackStyle;
import org.json.JSONException;
import org.json.JSONObject;

/** Maps the sender's subtitle presets onto the Cast SDK style. */
final class CastSubtitleStyle {
    private CastSubtitleStyle() {}

    /** Maps the sender's subtitle presets ({@code size}, {@code color}, {@code shadow}, {@code background}) onto {@link TextTrackStyle};
     *  a null {@code spec} gives the receiver-matching defaults. */
    static TextTrackStyle build(JSObject spec) {
        TextTrackStyle style = new TextTrackStyle();
        style.setFontGenericFamily(TextTrackStyle.FONT_FAMILY_SANS_SERIF);
        style.setWindowType(TextTrackStyle.WINDOW_TYPE_NONE);
        style.setWindowColor(0x00000000);
        String size = spec != null ? spec.optString("size", "normal") : "normal";
        String color = spec != null ? spec.optString("color", "white") : "white";
        String shadow = spec != null ? spec.optString("shadow", "drop") : "drop";
        String bg = spec != null ? spec.optString("background", "transparent") : "transparent";
        style.setFontScale(mapSize(size));
        style.setForegroundColor(mapFgColor(color));
        style.setBackgroundColor(mapBgColor(bg));
        int[] edge = mapShadow(shadow);
        style.setEdgeType(edge[0]);
        style.setEdgeColor(edge[1]);
        try {
            style.setCustomData(new JSONObject().put("bottomMargin", spec != null ? spec.optDouble("bottomMargin", 0) : 0));
        } catch (JSONException ignored) {}
        return style;
    }

    /** Mirrors CAST_SUBTITLE_SIZE_SCALE (subtitle-presets.ts). */
    private static float mapSize(String name) {
        switch (name) {
            case "xsmall": return 0.7f;
            case "small": return 0.775f;
            case "large": return 0.975f;
            case "xlarge": return 1.1f;
            default: return 0.85f;
        }
    }

    private static int mapFgColor(String name) {
        switch (name) {
            case "yellow": return 0xFFFFFF00;
            case "green": return 0xFF00FF00;
            case "cyan": return 0xFF00FFFF;
            default: return 0xFFFFFFFF;
        }
    }

    private static int mapBgColor(String name) {
        switch (name) {
            case "semi": return 0x80000000;
            case "black": return 0xFF000000;
            // Cast SDK strips integer colors equal to 0 from the wire (read as unset), so the receiver would default to an opaque
            // black box: use alpha 0 with a non-zero value (#01000000), still transparent, sent as an explicit backgroundColor.
            default: return 0x00010000;
        }
    }

    /** Returns {edgeType, edgeColor}. */
    private static int[] mapShadow(String name) {
        switch (name) {
            // Same wire omission as transparent backgrounds: a 0 color is stripped. The edge isn't drawn when type=NONE,
            // the non-zero value just keeps the frame complete.
            case "none": return new int[] { TextTrackStyle.EDGE_TYPE_NONE, 0x00010000 };
            case "outline": return new int[] { TextTrackStyle.EDGE_TYPE_OUTLINE, 0xFF000000 };
            case "raised": return new int[] { TextTrackStyle.EDGE_TYPE_RAISED, 0xFF000000 };
            default: return new int[] { TextTrackStyle.EDGE_TYPE_DROP_SHADOW, 0xFF000000 };
        }
    }
}
