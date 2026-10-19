package media.fliks.app;

import com.getcapacitor.JSObject;
import com.google.android.gms.cast.TextTrackStyle;

/** Maps the sender's subtitle presets onto the Cast SDK style. */
final class CastSubtitleStyle {
    private CastSubtitleStyle() {}

    /**
     * Map the sender's subtitle presets ({@code size} / {@code color} /
     * {@code shadow} / {@code background}) onto Cast SDK's
     * {@link TextTrackStyle}. Same preset vocabulary as the local
     * player settings — keeps a single shared UI between both. When
     * {@code spec} is null, returns the receiver-matching defaults.
     */
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
            // Cast SDK on Android strips integer-color fields equal to
            // 0 from the wire payload (treats them as "unset"), so the
            // receiver falls through to CAF's built-in default — which
            // happens to render an opaque black box. Use a non-zero
            // value with alpha 0: still fully transparent visually,
            // but serialised on the wire as #01000000 so the receiver
            // sees an explicit transparent backgroundColor.
            default: return 0x00010000;
        }
    }

    /** Returns {edgeType, edgeColor}. */
    private static int[] mapShadow(String name) {
        switch (name) {
            // Same wire-omission concern as transparent backgrounds —
            // a 0 colour is stripped, the receiver picks its default.
            // Edge isn't rendered when type=NONE so the visible result
            // is the same; we keep the wire frame complete for
            // determinism / debuggability.
            case "none": return new int[] { TextTrackStyle.EDGE_TYPE_NONE, 0x00010000 };
            case "outline": return new int[] { TextTrackStyle.EDGE_TYPE_OUTLINE, 0xFF000000 };
            case "raised": return new int[] { TextTrackStyle.EDGE_TYPE_RAISED, 0xFF000000 };
            default: return new int[] { TextTrackStyle.EDGE_TYPE_DROP_SHADOW, 0xFF000000 };
        }
    }
}
