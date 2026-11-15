/** AVPlay probes kept apart from {@link TizenEngine} so the eager bundle can call them without the engine. */
type AvplayGlobal = { webapis?: { avplay?: { setVideoRoi?: unknown } } };

export const isTizenAvplayAvailable = (): boolean =>
  typeof window !== 'undefined' && typeof (window as unknown as AvplayGlobal).webapis?.avplay === 'object';

/** Firmware that exposes the video region-of-interest API can crop letterbox bars on the plane. */
export const isTizenCropSupported = (): boolean =>
  isTizenAvplayAvailable() && typeof (window as unknown as AvplayGlobal).webapis!.avplay!.setVideoRoi === 'function';
