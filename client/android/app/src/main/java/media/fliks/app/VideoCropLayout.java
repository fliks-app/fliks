package media.fliks.app;

/**
 * Mirrors {@code computeVideoCropStyle} (player.utils.ts) and iOS's
 * {@code VideoCropLayout}: the video frame that maps a crop rectangle onto a
 * container, fit or fill. Pure math, no Android types, so it's plain-JVM
 * testable.
 */
final class VideoCropLayout {
    private VideoCropLayout() {}

    /** Letterbox crop of the video, in source pixels. */
    static final class Crop {
        final float x, y, width, height, sourceWidth, sourceHeight;

        Crop(float x, float y, float width, float height, float sourceWidth, float sourceHeight) {
            this.x = x;
            this.y = y;
            this.width = width;
            this.height = height;
            this.sourceWidth = sourceWidth;
            this.sourceHeight = sourceHeight;
        }
    }

    /**
     * {x, y, width, height} frame in container coordinates (x/y may be negative), or
     * null when there's no effective crop (none set, or it covers the whole source).
     * {@code displayW/H} is the presented size (anamorphic-corrected); &lt;= 0 falls
     * back to the source size.
     */
    static int[] frame(int containerW, int containerH, Crop crop,
                        float displayW, float displayH, boolean fill) {
        if (crop == null || containerW <= 0 || containerH <= 0
                || crop.sourceWidth <= 0 || crop.sourceHeight <= 0
                || crop.width <= 0 || crop.height <= 0) {
            return null;
        }
        if (crop.width >= crop.sourceWidth && crop.height >= crop.sourceHeight) return null;

        boolean hasDisplay = displayW > 0 && displayH > 0;
        float dw = hasDisplay ? displayW : crop.sourceWidth;
        float dh = hasDisplay ? displayH : crop.sourceHeight;
        float sx = dw / crop.sourceWidth;
        float sy = dh / crop.sourceHeight;
        float cropW = crop.width * sx;
        float cropH = crop.height * sy;
        float scaleX = (float) containerW / cropW;
        float scaleY = (float) containerH / cropH;
        float scale = fill ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);

        int x = Math.round((containerW - cropW * scale) / 2 - crop.x * sx * scale);
        int y = Math.round((containerH - cropH * scale) / 2 - crop.y * sy * scale);
        int w = Math.round(dw * scale);
        int h = Math.round(dh * scale);
        return new int[] { x, y, w, h };
    }
}
