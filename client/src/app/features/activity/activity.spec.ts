import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { afterEach, describe, expect, it } from 'vitest';
import { ServerVersionService } from '../../core/services/server-version.service';
import { ActivityComponent } from './activity';

function tabs(supported: boolean): string[] {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      provideTranslateService(),
      { provide: ServerVersionService, useValue: { supports: () => supported } },
    ],
  });
  const fixture = TestBed.createComponent(ActivityComponent);
  fixture.detectChanges();
  return [...(fixture.nativeElement as HTMLElement).querySelectorAll('[role="tab"]')].map((a) => a.getAttribute('href')!);
}

describe('ActivityComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('shows the queue, wanted and history tabs', () => {
    expect(tabs(true)).toEqual(['/queue', '/wanted', '/history']);
  });

  it('keeps only the wanted tab on a server without the queue routes', () => {
    expect(tabs(false)).toEqual(['/wanted']);
  });
});
