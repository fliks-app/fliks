import { Injectable, computed, signal } from '@angular/core';
import { computeVideoCropStyle, type CropRect, type VideoCropStyle } from '../../core/utils/player.utils';

/** What the controller needs from the player, so it never reaches into the
 *  component directly. */
export interface WebVideoCropHost {
  /** mpv crops decode-side; this controller only ever applies to CSS. */
  isDesktopEngine(): boolean;
  activeCropRect(): CropRect | undefined;
  sourceSize(): { width: number; height: number };
  fit(): 'contain' | 'cover';
  containerElement(): HTMLElement | undefined;
  videoElement(): HTMLVideoElement | undefined;
}

/**
 * Owns the CSS crop applied to the `<video>` element every non-desktop
 * engine renders into: the black bars from a source's own letterboxing are
 * cut by scaling/translating the element itself. Provided per player
 * component and wired to it via {@link attach}.
 */
@Injectable()
export class WebVideoCropController {
  private host!: WebVideoCropHost;
  private resizeObserver: ResizeObserver | null = null;

  /** Web-crop box; null keeps the template's plain `object-fit: contain/cover`. */
  readonly videoCropStyle = signal<VideoCropStyle | null>(null);
  readonly videoCropTransform = computed(() => {
    const s = this.videoCropStyle();
    return s ? `translate(${s.translateX}px, ${s.translateY}px)` : null;
  });

  attach(host: WebVideoCropHost): void {
    this.host = host;
  }

  /** The container's own box (not window resize) is what the crop transform
   *  needs — it also catches fullscreen toggles and iOS reflow. Call once
   *  the view (and its container element) exists. */
  init(): void {
    if (typeof ResizeObserver === 'undefined') return;
    this.resizeObserver = new ResizeObserver(() => this.refresh());
    const container = this.host.containerElement();
    if (container) this.resizeObserver.observe(container);
  }

  /** Re-fit the CSS crop to a new container box or decoded size: an
   *  anamorphic source reports its display size only once loaded. */
  refresh(): void {
    if (this.host.isDesktopEngine()) return;
    const crop = this.host.activeCropRect();
    const container = this.host.containerElement();
    const video = this.host.videoElement();
    const { width: sourceWidth, height: sourceHeight } = this.host.sourceSize();
    const style =
      crop && container
        ? computeVideoCropStyle({
            sourceWidth,
            sourceHeight,
            displayWidth: video?.videoWidth || undefined,
            displayHeight: video?.videoHeight || undefined,
            crop,
            containerWidth: container.clientWidth,
            containerHeight: container.clientHeight,
            fit: this.host.fit(),
          })
        : null;
    this.videoCropStyle.set(style);
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
  }
}
