import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucideSend } from '@lucide/angular';
import { PARTY_EMOJIS, type PartyMessage } from '../../../core/services/api/party-api.service';
import { DeviceService } from '../../../core/services/device.service';
import { KeyboardOverlayService } from '../../../core/services/keyboard-overlay.service';
import { PartyService } from '../../../core/services/party/party.service';
import { formatTime } from '../../../core/utils/player.utils';
import { TvRowDirective } from '../../../shared/directives/tv-row.directive';

const MAX_LENGTH = 500;

/** Messages, reactions and the composer of the current party: shared by the player panel and the lobby. */
@Component({
  selector: 'app-party-chat',
  imports: [TranslatePipe, LucideSend, TvRowDirective],
  templateUrl: './party-chat.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-h-0 flex-1 flex-col' },
})
export class PartyChatComponent {
  protected readonly party = inject(PartyService);
  private readonly translate = inject(TranslateService);
  protected readonly isTv = inject(DeviceService).isTv;
  private readonly keyboard = inject(KeyboardOverlayService);
  /** Phrases stand in for the keyboard on the TV and on a phone in landscape, where it fills the screen. */
  // While typing, the space left above the keyboard holds only the messages and the input.
  protected readonly typing = computed(() => this.keyboard.height() > 0);
  protected readonly showPhrases = computed(() => !this.typing() && (this.isTv() || this.party.dock() === 'drawer'));

  protected readonly maxLength = MAX_LENGTH;
  protected readonly emojis = PARTY_EMOJIS;
  protected readonly phrases = ['party.tv_phrase_pause', 'party.tv_phrase_5min', 'party.tv_phrase_wait'];
  /** TV: free text stays closed until the viewer asks for it. */
  protected readonly writing = signal(false);
  protected readonly draft = signal('');

  private readonly list = viewChild<ElementRef<HTMLElement>>('list');
  private readonly input = viewChild<ElementRef<HTMLInputElement>>('input');

  constructor() {
    effect(() => {
      this.party.messages();
      // The keyboard shrinks the list: keep the latest messages in view.
      this.typing();
      const el = this.list()?.nativeElement;
      if (el) requestAnimationFrame(() => (el.scrollTop = el.scrollHeight));
    });
  }

  protected systemText(m: PartyMessage): string {
    const sys = m.system!;
    const position = typeof sys.args?.['position'] === 'number' ? formatTime(sys.args['position']) : '';
    return this.translate.instant(`party.system.${sys.kind}`, { by: sys.by ?? '', position });
  }

  protected onInput(event: Event): void {
    this.draft.set((event.target as HTMLInputElement).value);
  }

  protected send(): void {
    const text = this.draft().trim();
    if (!text) return;
    this.draft.set('');
    const el = this.input()?.nativeElement;
    if (el) el.value = '';
    void this.party.sendMessage(text);
    if (this.isTv()) this.writing.set(false);
  }

  protected sendPhrase(key: string): void {
    void this.party.sendMessage(this.translate.instant(key));
  }

  protected startWriting(): void {
    this.writing.set(true);
    queueMicrotask(() => this.input()?.nativeElement.focus());
  }
}
