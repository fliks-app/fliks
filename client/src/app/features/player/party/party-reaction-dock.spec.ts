import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DismissableStackService } from '../../../core/services/dismissable-stack.service';
import { PartyService } from '../../../core/services/party/party.service';
import { ReactionsService } from '../../../core/services/party/reactions.service';
import { PartyReactionDockComponent } from './party-reaction-dock';

function setup() {
  const rowOpen = signal(true);
  const reactions = {
    bar: () => ['🔥', '😂'],
    keepOpen: signal(false),
    rowOpen,
    setRowOpen: (v: boolean) => rowOpen.set(v),
  };
  const party = { react: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      { provide: ReactionsService, useValue: reactions },
      { provide: PartyService, useValue: party },
      { provide: DismissableStackService, useValue: { push: vi.fn(), remove: vi.fn() } },
      provideTranslateService({ loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
    ],
  });
  const fixture = TestBed.createComponent(PartyReactionDockComponent);
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  // The player container, listening where the real one does.
  const wake = vi.fn();
  const outer = document.createElement('div');
  for (const t of ['click', 'dblclick', 'mousemove']) outer.addEventListener(t, wake);
  outer.append(host);
  document.body.append(outer);
  return { fixture, host, party, wake, rowOpen };
}

describe('PartyReactionDockComponent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Element.prototype.animate = (() => ({ finished: Promise.resolve() })) as never;
  });
  afterEach(() => vi.useRealTimers());

  it('keeps click, dblclick and mousemove from reaching the player', () => {
    const { host, wake } = setup();
    const emoji = host.querySelector<HTMLElement>('.emoji')!;
    for (const t of ['click', 'dblclick', 'mousemove']) emoji.dispatchEvent(new Event(t, { bubbles: true }));
    expect(wake).not.toHaveBeenCalled();
  });

  it('absorbs the second tap of a fast double tap after the row folds, without sending twice', async () => {
    const { fixture, host, party, wake, rowOpen } = setup();
    host.querySelector<HTMLElement>('.emoji')!.click();
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    expect(rowOpen()).toBe(false);

    const absorb = host.querySelector<HTMLElement>('.absorb')!;
    expect(absorb).not.toBeNull();
    absorb.click();
    host.querySelector<HTMLElement>('.emoji')!.click();
    expect(party.react).toHaveBeenCalledTimes(1);
    expect(wake).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    fixture.detectChanges();
    expect(host.querySelector('.absorb')).toBeNull();
  });

  const fire = (el: Element, types: string[]) => {
    for (const t of types) el.dispatchEvent(new MouseEvent(t, { bubbles: true, detail: t === 'dblclick' ? 2 : 1 }));
  };

  it('desktop mouse double click (mpv UI window): no click or dblclick reaches the player', async () => {
    const { fixture, host, wake } = setup();
    const emoji = host.querySelector<HTMLElement>('.emoji')!;
    fire(emoji, ['mousedown', 'mouseup', 'click']);
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    const absorb = host.querySelector<HTMLElement>('.absorb')!;
    fire(absorb, ['mousedown', 'mouseup', 'click', 'dblclick']);
    expect(wake).not.toHaveBeenCalled();
  });

  it('touch double tap (iOS WebView over the native layer): the synthesized clicks stay in the dock', async () => {
    const { fixture, host, wake } = setup();
    const emoji = host.querySelector<HTMLElement>('.emoji')!;
    fire(emoji, ['pointerdown', 'touchstart', 'pointerup', 'touchend', 'mousemove', 'mousedown', 'mouseup', 'click']);
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    const absorb = host.querySelector<HTMLElement>('.absorb')!;
    fire(absorb, ['pointerdown', 'touchstart', 'pointerup', 'touchend', 'mousemove', 'mousedown', 'mouseup', 'click', 'dblclick']);
    expect(wake).not.toHaveBeenCalled();
  });
});
