import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { BlockingOverlayComponent } from './blocking-overlay';

function mount() {
  const fixture = TestBed.createComponent(BlockingOverlayComponent);
  const dialog = fixture.nativeElement.querySelector('dialog') as HTMLDialogElement;
  dialog.showModal = vi.fn(() => dialog.setAttribute('open', ''));
  dialog.close = vi.fn(() => dialog.removeAttribute('open'));
  fixture.componentRef.setInput('open', false);
  fixture.componentRef.setInput('message', 'Updating');
  fixture.detectChanges();
  return { fixture, dialog, el: fixture.nativeElement as HTMLElement };
}

describe('BlockingOverlayComponent', () => {
  it('opens and closes with its input', () => {
    const { fixture, dialog } = mount();
    expect(dialog.open).toBe(false);
    fixture.componentRef.setInput('open', true);
    fixture.detectChanges();
    expect(dialog.open).toBe(true);
    fixture.componentRef.setInput('open', false);
    fixture.detectChanges();
    expect(dialog.open).toBe(false);
  });

  it('shows a spinner without progress and a bar with it', () => {
    const { fixture, el } = mount();
    expect(el.querySelector('.loading')).not.toBeNull();
    fixture.componentRef.setInput('progress', 40);
    fixture.detectChanges();
    expect(el.querySelector('.loading')).toBeNull();
    expect(el.querySelector('progress')?.getAttribute('value')).toBe('40');
  });

  it('renders the message and runs an action', () => {
    const { fixture, el } = mount();
    const run = vi.fn();
    fixture.componentRef.setInput('actions', [{ label: 'Reload', run }]);
    fixture.detectChanges();
    expect(el.querySelector('p')?.textContent).toBe('Updating');
    el.querySelector('button')!.click();
    expect(run).toHaveBeenCalled();
  });
});
