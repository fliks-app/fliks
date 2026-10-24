import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, signal, viewChild } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucideCrown, LucideRefreshCw, LucideSend, LucideX } from '@lucide/angular';
import { PARTY_EMOJIS, type PartyMessage } from '../../../core/services/api/party-api.service';
import { DeviceService } from '../../../core/services/device.service';
import { DismissableStackService } from '../../../core/services/dismissable-stack.service';
import { PartyService } from '../../../core/services/party/party.service';
import { formatTime } from '../../../core/utils/player.utils';
import { TvRowDirective } from '../../../shared/directives/tv-row.directive';
import { TvSectionDirective } from '../../../shared/directives/tv-section.directive';
import { PartyController } from '../party-controller';

const MAX_LENGTH = 500;

@Component({
  selector: 'app-party-panel',
  imports: [TranslatePipe, LucideCrown, LucideRefreshCw, LucideSend, LucideX, TvRowDirective, TvSectionDirective],
  templateUrl: './party-panel.html',
  styleUrl: './party-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[attr.data-dock]': 'party.dock()', '[class.party-tv]': 'isTv()' },
})
export class PartyPanelComponent {
  protected readonly party = inject(PartyService);
  private readonly controller = inject(PartyController);
  private readonly dismissStack = inject(DismissableStackService);
  private readonly translate = inject(TranslateService);
  protected readonly isTv = inject(DeviceService).isTv;

  protected readonly maxLength = MAX_LENGTH;
  protected readonly emojis = PARTY_EMOJIS;
  protected readonly phrases = ['party.tv_phrase_pause', 'party.tv_phrase_5min', 'party.tv_phrase_wait'];
  protected readonly tab = signal<'members' | 'chat'>('chat');
  /** TV: free text stays closed until the viewer asks for it. */
  protected readonly writing = signal(false);
  protected readonly draft = signal('');

  private readonly list = viewChild<ElementRef<HTMLElement>>('list');
  private readonly input = viewChild<ElementRef<HTMLInputElement>>('input');

  constructor() {
    // Back closes the panel before it leaves the player.
    effect((onCleanup) => {
      if (!this.party.panelOpen()) return;
      const close = () => this.party.setPanelOpen(false);
      this.dismissStack.push(close);
      onCleanup(() => this.dismissStack.remove(close));
    });
    effect(() => {
      this.party.messages();
      this.tab();
      const el = this.list()?.nativeElement;
      if (el) queueMicrotask(() => (el.scrollTop = el.scrollHeight));
    });
  }

  protected close(): void {
    this.party.setPanelOpen(false);
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

  protected resync(): void {
    this.controller.resync();
  }

  protected setHostOnly(event: Event): void {
    void this.party.setPolicy((event.target as HTMLInputElement).checked ? 'host_only' : 'everyone');
  }
}
