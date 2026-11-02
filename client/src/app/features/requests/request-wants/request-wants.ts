import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LocalizeLanguagePipe } from '../../../core/pipes/localize-language.pipe';
import type { WantSpec } from '../../../core/services/api/wants-api.service';

/** The editions a book request asks for, e.g. ebook (French), audio (any language). */
@Component({
  selector: 'app-request-wants',
  imports: [TranslatePipe, LocalizeLanguagePipe],
  templateUrl: './request-wants.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RequestWantsComponent {
  readonly wants = input.required<WantSpec[]>();
}
