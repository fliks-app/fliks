import { Capacitor } from '@capacitor/core';
import type { PlaybackEngine } from './playback-engine';
import { ShakaEngine } from './shaka-engine';
import { NativeEngine } from './native-engine';
import { DesktopEngine } from './desktop-engine';
import { TizenEngine, isTizenAvplayAvailable } from './tizen-engine';
import { WebOsEngine } from './webos-engine';

export type EngineSurfaceKind = 'shaka' | 'webos' | 'tizen' | 'native' | 'desktop';

export interface EngineSurface {
  engine: PlaybackEngine;
  kind: EngineSurfaceKind;
  /**
   * The decoder paints on its own plane behind the WebView rather than into the
   * page's `<video>`. Everything above it has to stay transparent or the picture
   * reads as black, and the page's `<video>` is dead weight.
   */
  usesNativeSurface: boolean;
}

const NATIVE_SURFACE: ReadonlySet<EngineSurfaceKind> = new Set(['tizen', 'native', 'desktop']);

export function usesNativeSurface(kind: EngineSurfaceKind): boolean {
  return NATIVE_SURFACE.has(kind);
}

/** Which engine this platform plays with, before any per-feature wiring. The
 *  two probes are parameters so a test can state a platform instead of faking
 *  one. */
export function engineSurfaceKind(opts: {
  tvPlatform: string | null;
  isDesktopNative: boolean;
  hasTizenAvplay?: boolean;
  isCapacitorNative?: boolean;
}): EngineSurfaceKind {
  if (opts.hasTizenAvplay ?? isTizenAvplayAvailable()) return 'tizen';
  if (opts.tvPlatform === 'webos') return 'webos';
  if (opts.isCapacitorNative ?? Capacitor.isNativePlatform()) return 'native';
  if (opts.isDesktopNative) return 'desktop';
  return 'shaka';
}

/**
 * Prepares the page for the engine and answers where it should attach. Every
 * clause here has been a bug on its own: a page left opaque over the decoder's
 * plane, a `<video>` left visible above it, the transparency hook never set.
 */
export function applySurfaceContract(
  kind: EngineSurfaceKind,
  video: HTMLVideoElement,
  container?: HTMLElement | null,
): HTMLElement {
  if (!usesNativeSurface(kind)) return video;
  video.style.display = 'none';
  document.documentElement.classList.add('native-player-active');
  return container ?? video.parentElement!;
}

/** Undoes what {@link applySurfaceContract} set on the document. */
export function releaseEngineSurface(): void {
  document.documentElement.classList.remove('native-player-active');
}

function engineFor(kind: EngineSurfaceKind): PlaybackEngine {
  switch (kind) {
    case 'tizen':
      return new TizenEngine();
    case 'webos':
      return new WebOsEngine();
    case 'native':
      return new NativeEngine();
    case 'desktop':
      return new DesktopEngine();
    default:
      return new ShakaEngine();
  }
}

/** Both players go through here, so the contract cannot be half-applied. */
export async function createEngineSurface(opts: {
  kind: EngineSurfaceKind;
  video: HTMLVideoElement;
  container?: HTMLElement | null;
}): Promise<EngineSurface> {
  const target = applySurfaceContract(opts.kind, opts.video, opts.container);
  const engine = engineFor(opts.kind);
  await engine.init(target);
  return { engine, kind: opts.kind, usesNativeSurface: usesNativeSurface(opts.kind) };
}
