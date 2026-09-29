package media.fliks.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

/** Mirrors the cases in client/src/app/core/utils/player.utils.spec.ts
 *  (computeVideoCropStyle): {x,y,w,h} here equal that spec's
 *  {translateX,translateY,width,height}. */
public class VideoCropLayoutTest {

    @Test
    public void contain_cropArMatchesContainerAr_noPillarboxAroundCrop() {
        VideoCropLayout.Crop crop = new VideoCropLayout.Crop(0, 140, 1920, 800, 1920, 1080);
        assertArrayEquals(new int[] { 0, -175, 2400, 1350 },
                VideoCropLayout.frame(2400, 1000, crop, 0, 0, false));
    }

    @Test
    public void contain_cropNarrowerThanContainerAr_pillarboxedLikeServerCrop() {
        VideoCropLayout.Crop crop = new VideoCropLayout.Crop(200, 0, 600, 1000, 1000, 1000);
        assertArrayEquals(new int[] { 200, 0, 400, 400 },
                VideoCropLayout.frame(800, 400, crop, 0, 0, false));
    }

    @Test
    public void cover_fillsContainerAndClipsCropSymmetrically() {
        VideoCropLayout.Crop crop = new VideoCropLayout.Crop(0, 270, 3840, 1620, 3840, 2160);
        assertArrayEquals(new int[] { -320, -180, 2560, 1440 },
                VideoCropLayout.frame(1920, 1080, crop, 0, 0, true));
    }

    @Test
    public void nullWhenCropCoversWholeFrame() {
        VideoCropLayout.Crop crop = new VideoCropLayout.Crop(0, 0, 1920, 1080, 1920, 1080);
        assertNull(VideoCropLayout.frame(1920, 1080, crop, 0, 0, false));
    }

    @Test
    public void nullForZeroSizedContainer() {
        VideoCropLayout.Crop crop = new VideoCropLayout.Crop(0, 256, 3840, 1648, 3840, 2160);
        assertNull(VideoCropLayout.frame(0, 0, crop, 0, 0, false));
    }

    @Test
    public void nullForDegenerateCropRectangle() {
        VideoCropLayout.Crop crop = new VideoCropLayout.Crop(0, 0, 0, 0, 1920, 1080);
        assertNull(VideoCropLayout.frame(1920, 1080, crop, 0, 0, false));
    }

    @Test
    public void anamorphic_rescalesCodedGridCropOntoDecodedDisplayGrid() {
        VideoCropLayout.Crop crop = new VideoCropLayout.Crop(0, 90, 1440, 900, 1440, 1080);
        assertArrayEquals(new int[] { 0, -40, 1920, 1080 },
                VideoCropLayout.frame(1920, 1000, crop, 1920, 1080, false));
    }

    @Test
    public void anamorphic_palDvdCropsCodedBarsCorrectly() {
        VideoCropLayout.Crop crop = new VideoCropLayout.Crop(0, 48, 720, 480, 720, 576);
        assertArrayEquals(new int[] { 0, -48, 768, 576 },
                VideoCropLayout.frame(768, 480, crop, 768, 576, false));
    }
}
