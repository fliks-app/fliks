import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { afterEach, describe, expect, it } from 'vitest';
import { PlaybackDevice } from '../../core/services/playback-device.service';
import { DeviceChipComponent } from './device-chip';

function setup(name: string | null, icon = 'monitor') {
  TestBed.configureTestingModule({
    providers: [
      provideTranslateService(),
      provideZonelessChangeDetection(),
      { provide: PlaybackDevice, useValue: { name: signal(name), icon: signal(icon) } },
    ],
  });
  const fixture = TestBed.createComponent(DeviceChipComponent);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  return { el, button: el.querySelector('button')! };
}

describe('DeviceChipComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('shows the icon only, neutral, on this device', () => {
    const { el, button } = setup(null, 'phone');
    expect(el.querySelector('svg')).not.toBeNull();
    expect(el.querySelector('span')).toBeNull();
    expect(button.classList.contains('text-info')).toBe(false);
    expect(button.getAttribute('aria-label')).toBe('remote.this_device');
  });

  it('shows the device name in the accent colour on another device', () => {
    const { el, button } = setup('Living room', 'tv');
    expect(el.textContent).toContain('Living room');
    expect(button.classList.contains('text-info')).toBe(true);
    expect(button.getAttribute('aria-label')).toBe('session.playing_on');
  });
});
