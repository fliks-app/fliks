import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { ModalHeaderComponent } from '../../../shared/components/modal-header';

/** On-screen size of the circular crop viewport. */
const VIEWPORT = 256;
/** Side of the square image produced for upload (px). */
const OUTPUT = 512;

/**
 * Client-side avatar cropper. Opened with a picked image {@link open}, it lets
 * the user pan (drag) and zoom (slider) a square region, then emits a
 * 512×512 JPEG blob through {@link cropped} — the server stores the bytes
 * as-is, so no image processing is needed backend-side. The crop is previewed
 * as a circle (how avatars render everywhere) while the exported file stays
 * square (the circle's bounding box).
 */
@Component({
  selector: 'app-avatar-editor',
  imports: [
    ModalHeaderComponent,TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './avatar-editor.html',
})
export class AvatarEditorComponent {
  private readonly dialogEl =
    viewChild<ElementRef<HTMLDialogElement>>('dialog');

  readonly cropped = output<Blob>();

  readonly vp = VIEWPORT;
  readonly imgSrc = signal<string | null>(null);
  readonly zoom = signal(1);
  readonly busy = signal(false);

  private readonly naturalW = signal(0);
  private readonly naturalH = signal(0);
  private readonly offsetX = signal(0);
  private readonly offsetY = signal(0);

  private image: HTMLImageElement | null = null;
  private objectUrl: string | null = null;
  private dragging = false;
  private startX = 0;
  private startY = 0;
  private startOffX = 0;
  private startOffY = 0;

  /** Minimum scale so the image always covers the square viewport. */
  private readonly coverScale = computed(() => {
    const w = this.naturalW();
    const h = this.naturalH();
    if (!w || !h) return 1;
    return VIEWPORT / Math.min(w, h);
  });
  private readonly scale = computed(() => this.coverScale() * this.zoom());

  readonly dispW = computed(() => this.naturalW() * this.scale());
  readonly dispH = computed(() => this.naturalH() * this.scale());
  readonly offX = this.offsetX.asReadonly();
  readonly offY = this.offsetY.asReadonly();

  /** Load a picked image and open the dialog. */
  open(file: File): void {
    this.revoke();
    this.busy.set(false);
    const url = URL.createObjectURL(file);
    this.objectUrl = url;
    const img = new Image();
    img.onload = () => {
      this.image = img;
      this.naturalW.set(img.naturalWidth);
      this.naturalH.set(img.naturalHeight);
      this.zoom.set(1);
      this.imgSrc.set(url);
      this.centerOffsets();
      this.dialogEl()?.nativeElement.showModal();
    };
    img.onerror = () => this.revoke();
    img.src = url;
  }

  close(): void {
    this.dialogEl()?.nativeElement.close();
    this.revoke();
    this.image = null;
    this.imgSrc.set(null);
  }

  onZoomChange(z: number): void {
    const cx = VIEWPORT / 2;
    const old = this.scale();
    const sx = (cx - this.offsetX()) / old;
    const sy = (cx - this.offsetY()) / old;
    this.zoom.set(z);
    const next = this.scale();
    // Keep the viewport centre anchored on the same source point while zooming.
    this.offsetX.set(this.clampX(cx - sx * next));
    this.offsetY.set(this.clampY(cx - sy * next));
  }

  onPointerDown(e: PointerEvent): void {
    this.dragging = true;
    this.startX = e.clientX;
    this.startY = e.clientY;
    this.startOffX = this.offsetX();
    this.startOffY = this.offsetY();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }

  onPointerMove(e: PointerEvent): void {
    if (!this.dragging) return;
    this.offsetX.set(this.clampX(this.startOffX + (e.clientX - this.startX)));
    this.offsetY.set(this.clampY(this.startOffY + (e.clientY - this.startY)));
  }

  onPointerUp(e: PointerEvent): void {
    this.dragging = false;
    try {
      (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    } catch {
      /* pointer already released */
    }
  }

  async confirm(): Promise<void> {
    if (!this.image || this.busy()) return;
    this.busy.set(true);
    const scale = this.scale();
    const srcSize = VIEWPORT / scale;
    const srcX = -this.offsetX() / scale;
    const srcY = -this.offsetY() / scale;
    const canvas = document.createElement('canvas');
    canvas.width = OUTPUT;
    canvas.height = OUTPUT;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      this.busy.set(false);
      return;
    }
    ctx.drawImage(this.image, srcX, srcY, srcSize, srcSize, 0, 0, OUTPUT, OUTPUT);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.9),
    );
    if (blob) this.cropped.emit(blob);
    this.close();
  }

  private centerOffsets(): void {
    this.offsetX.set((VIEWPORT - this.dispW()) / 2);
    this.offsetY.set((VIEWPORT - this.dispH()) / 2);
  }

  private clampX(x: number): number {
    return Math.min(0, Math.max(VIEWPORT - this.dispW(), x));
  }

  private clampY(y: number): number {
    return Math.min(0, Math.max(VIEWPORT - this.dispH(), y));
  }

  private revoke(): void {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }
}
