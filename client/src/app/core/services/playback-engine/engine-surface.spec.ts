import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  applySurfaceContract,
  engineSurfaceKind,
  releaseEngineSurface,
  usesNativeSurface,
  type EngineSurfaceKind,
} from './engine-surface';

describe('engineSurfaceKind', () => {
  const base = { hasTizenAvplay: false, isCapacitorNative: false };

  it('prefers AVPlay when the TV exposes it, over every other signal', () => {
    expect(
      engineSurfaceKind({ ...base, hasTizenAvplay: true, tvPlatform: 'webos', isDesktopNative: true }),
    ).toBe('tizen');
  });

  it('maps webOS, Capacitor and Electron to their own engines', () => {
    expect(engineSurfaceKind({ ...base, tvPlatform: 'webos', isDesktopNative: false })).toBe('webos');
    expect(
      engineSurfaceKind({ ...base, isCapacitorNative: true, tvPlatform: null, isDesktopNative: false }),
    ).toBe('native');
    expect(engineSurfaceKind({ ...base, tvPlatform: null, isDesktopNative: true })).toBe('desktop');
  });

  it('falls back to the browser engine', () => {
    expect(engineSurfaceKind({ ...base, tvPlatform: null, isDesktopNative: false })).toBe('shaka');
  });
});

describe('applySurfaceContract', () => {
  let video: HTMLVideoElement;
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    video = document.createElement('video');
    container.appendChild(video);
    document.documentElement.classList.remove('native-player-active');
  });
  afterEach(() => releaseEngineSurface());

  const hasHook = () => document.documentElement.classList.contains('native-player-active');

  for (const kind of ['tizen', 'native', 'desktop'] as EngineSurfaceKind[]) {
    it(`${kind}: attaches to the container, hides the page video, frees the page`, () => {
      expect(usesNativeSurface(kind)).toBe(true);
      expect(applySurfaceContract(kind, video, container)).toBe(container);
      expect(video.style.display).toBe('none');
      expect(hasHook()).toBe(true);
    });
  }

  for (const kind of ['shaka', 'webos'] as EngineSurfaceKind[]) {
    it(`${kind}: attaches to the video and never claims the transparency hook`, () => {
      expect(usesNativeSurface(kind)).toBe(false);
      expect(applySurfaceContract(kind, video, container)).toBe(video);
      expect(video.style.display).toBe('');
      expect(hasHook()).toBe(false);
    });
  }

  it('falls back to the video parent when no container is given', () => {
    expect(applySurfaceContract('native', video)).toBe(container);
  });

  it('releases the hook so the next page is not left transparent', () => {
    applySurfaceContract('native', video, container);
    releaseEngineSurface();
    expect(hasHook()).toBe(false);
  });
});
