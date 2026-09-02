package media.fliks.app;

import android.content.Context;
import android.graphics.Bitmap;
import android.view.Gravity;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.ImageView;

import androidx.annotation.OptIn;
import androidx.media3.common.text.Cue;
import androidx.media3.common.text.CueGroup;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.ui.CaptionStyleCompat;
import androidx.media3.ui.SubtitleView;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Owns the two on-screen subtitle layers for the native player:
 *
 * <ul>
 *   <li>{@code subtitleView} — ExoPlayer's {@link SubtitleView} for text cues,
 *       full-screen and bottom-anchored.</li>
 *   <li>{@code imageView} — our own {@link ImageView} for bitmap cues
 *       (PGS/VOBSUB), which {@link SubtitleView} stretches and squishes. Sized
 *       per-cue and pinned to the bottom of the screen.</li>
 * </ul>
 *
 * Text cues keep their default rendering; only bitmap cues go through the
 * custom sizing path.
 */
@OptIn(markerClass = UnstableApi.class)
class SubtitleOverlay {
    private SubtitleView subtitleView;
    private ImageView imageView;
    private final SurfaceView surfaceView;
    private float bottomMargin;

    SubtitleOverlay(Context ctx, ViewGroup webViewParent, FrameLayout wrapper, SurfaceView surfaceView) {
        this.surfaceView = surfaceView;

        // Z-order: 0=wrapper (video) → 1=subtitleView → 2=imageView → 3+=WebView
        subtitleView = new SubtitleView(ctx);
        webViewParent.addView(subtitleView, 1, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        subtitleView.addOnLayoutChangeListener(
                (v, l, t, r, b, ol, ot, or_, ob) -> applyBottomMargin());

        // Added to `wrapper` (a FrameLayout we own) so the gravity-bearing
        // FrameLayout.LayoutParams cast stays valid regardless of the host
        // WebView parent's layout type.
        imageView = new ImageView(ctx);
        imageView.setVisibility(View.GONE);
        wrapper.addView(imageView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL));
    }

    void onCues(CueGroup cueGroup) {
        List<Cue> textCues = new ArrayList<>();
        Cue bitmapCue = null;
        for (Cue c : cueGroup.cues) {
            if (c.bitmap != null) { if (bitmapCue == null) bitmapCue = c; }
            else textCues.add(c);
        }
        if (subtitleView != null) subtitleView.setCues(textCues);
        renderImageCue(bitmapCue);
    }

    /** Drop any on-screen cue (e.g. before a seek or fresh load). */
    void clear() {
        if (subtitleView != null) subtitleView.setCues(Collections.emptyList());
        renderImageCue(null);
    }

    /** Text height as a fraction of the view, matching the iOS overlay and the
     *  browser's `vh` cues: a fixed sp size reads half as tall on a tablet. */
    private static final float TEXT_SIZE_FRACTION = 0.035f;

    /** The lift translates the whole view instead of padding it: padding shrinks
     *  the canvas the fractional text size is measured against, so the cues used
     *  to shrink whenever the controls raised them. */
    void applyStyle(CaptionStyleCompat style, float fontScale, float bottomMarginFraction) {
        if (subtitleView == null) return;
        subtitleView.setStyle(style);
        subtitleView.setFractionalTextSize(TEXT_SIZE_FRACTION * fontScale, true);
        bottomMargin = bottomMarginFraction;
        applyBottomMargin();
    }

    private void applyBottomMargin() {
        if (subtitleView == null || subtitleView.getHeight() <= 0) return;
        subtitleView.setTranslationY(-subtitleView.getHeight() * bottomMargin);
    }

    /** Dim text cues when the screen is at max brightness (HDR mode). */
    void setTextAlpha(float alpha) {
        if (subtitleView != null) subtitleView.setAlpha(alpha);
    }

    void detach() {
        if (subtitleView != null) {
            ViewGroup parent = (ViewGroup) subtitleView.getParent();
            if (parent != null) parent.removeView(subtitleView);
            subtitleView = null;
        }
        if (imageView != null) {
            ViewGroup parent = (ViewGroup) imageView.getParent();
            if (parent != null) parent.removeView(imageView);
            imageView = null;
        }
    }

    private void renderImageCue(Cue cue) {
        if (imageView == null) return;
        if (cue == null || cue.bitmap == null) {
            imageView.setImageBitmap(null);
            imageView.setVisibility(View.GONE);
            return;
        }
        Bitmap bmp = cue.bitmap;
        ViewGroup parent = (ViewGroup) imageView.getParent();
        int screenH = parent != null && parent.getHeight() > 0 ? parent.getHeight() : 0;
        int screenW = parent != null && parent.getWidth() > 0 ? parent.getWidth() : 0;
        int videoW = surfaceView != null && surfaceView.getWidth() > 0
                ? surfaceView.getWidth() : screenW;
        int videoH = surfaceView != null && surfaceView.getHeight() > 0
                ? surfaceView.getHeight() : screenH;
        int targetW, targetH;
        if (cue.size != Cue.DIMEN_UNSET && videoW > 0) {
            targetW = Math.round(cue.size * videoW);
            targetH = Math.round(targetW * (float) bmp.getHeight() / bmp.getWidth());
        } else if (cue.bitmapHeight != Cue.DIMEN_UNSET && videoH > 0) {
            targetH = Math.round(cue.bitmapHeight * videoH);
            targetW = Math.round(targetH * (float) bmp.getWidth() / bmp.getHeight());
        } else {
            targetW = bmp.getWidth();
            targetH = bmp.getHeight();
        }
        // Portrait video is ~half as wide as landscape, so the proportional
        // size reads as tiny — boost it (capped to the screen width).
        if (screenW > 0 && screenH > screenW) {
            targetW = Math.round(targetW * 1.6f);
            targetH = Math.round(targetH * 1.6f);
            if (targetW > screenW) {
                targetH = Math.round(targetH * (float) screenW / targetW);
                targetW = screenW;
            }
        }
        targetW = Math.max(1, targetW);
        targetH = Math.max(1, targetH);
        ViewGroup.LayoutParams raw = imageView.getLayoutParams();
        FrameLayout.LayoutParams lp = raw instanceof FrameLayout.LayoutParams
                ? (FrameLayout.LayoutParams) raw
                : new FrameLayout.LayoutParams(targetW, targetH,
                        Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        lp.width = targetW;
        lp.height = targetH;
        lp.bottomMargin = screenH > 0 ? Math.round(screenH * 0.06f) : 0;
        imageView.setLayoutParams(lp);
        imageView.setScaleType(ImageView.ScaleType.FIT_XY);
        imageView.setImageBitmap(bmp);
        imageView.setVisibility(View.VISIBLE);
    }
}
