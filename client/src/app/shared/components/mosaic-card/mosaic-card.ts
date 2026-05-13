import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { LucideFolder } from '@lucide/angular';
import { ResolveUrlPipe } from '../../../core/pipes/resolve-url.pipe';
import { ImgFadeInDirective } from '../../directives/img-fade-in.directive';

@Component({
  selector: 'app-mosaic-card',
  imports: [LucideFolder, ResolveUrlPipe, ImgFadeInDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      class="group flex flex-col items-stretch gap-2 text-left focus:outline-none min-w-0 w-full"
      (click)="clicked.emit()"
    >
      <div class="aspect-square rounded-xl overflow-hidden bg-base-300 ring-1 ring-base-300 group-hover:ring-primary group-focus-visible:ring-primary group-focus-visible:ring-2 transition-colors">
        @if (posters().length >= 4) {
          <div class="grid grid-cols-2 grid-rows-2 w-full h-full">
            @for (p of posters().slice(0, 4); track p) {
              <img appImgFadeIn [src]="p | resolveUrl:'thumb'" alt="" loading="lazy" class="w-full h-full object-cover" />
            }
          </div>
        } @else if (posters().length > 0) {
          <img appImgFadeIn [src]="posters()[0] | resolveUrl:'medium'" alt="" loading="lazy" class="w-full h-full object-cover" />
        } @else {
          <div class="w-full h-full flex items-center justify-center text-base-content/30">
            <svg lucideFolder class="w-12 h-12" [strokeWidth]="1.5"></svg>
          </div>
        }
      </div>
      <div class="text-sm min-w-0 w-full">
        <div class="font-medium truncate group-hover:text-primary transition-colors">{{ label() }}</div>
        <div class="text-xs text-base-content/50">{{ count() }}</div>
      </div>
    </button>
  `,
})
export class MosaicCardComponent {
  readonly posters = input.required<string[]>();
  readonly label = input.required<string>();
  readonly count = input.required<number>();
  readonly clicked = output<void>();
}
