import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { describe, expect, it } from 'vitest';
import { AuthService } from './auth.service';
import { DisplaySettingsService } from './display-settings.service';
import { StreamingApiService } from './api/streaming-api.service';
import { BackgroundService } from './background.service';

function setup(): BackgroundService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: Router, useValue: { url: '/books/1', lastSuccessfulNavigation: signal(null), currentNavigation: () => null } },
      { provide: AuthService, useValue: { isAuthenticated: () => true } },
      { provide: DisplaySettingsService, useValue: { settings: () => ({ homeBackground: false }) } },
      { provide: StreamingApiService, useValue: { getRecommendations: () => Promise.resolve([]) } },
    ],
  });
  return TestBed.inject(BackgroundService);
}

describe('BackgroundService blur', () => {
  it('flags a claimed cover as blurred and a fanart claim as sharp', () => {
    const bg = setup();
    const owner = {};
    bg.set(owner, '/cover.jpg', { blur: true });
    expect(bg.url()).toBe('/cover.jpg');
    expect(bg.blur()).toBe(true);
    bg.set(owner, '/fanart.jpg');
    expect(bg.blur()).toBe(false);
    bg.release(owner);
    expect(bg.url()).toBeNull();
    expect(bg.blur()).toBe(false);
  });
});
