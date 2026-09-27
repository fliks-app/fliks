import { StreamBuilderService } from './stream-builder.service';

/** Shared fake-dependency constructor for StreamBuilderService specs: no HW
 *  accel, no tone-map override, crop off unless asked. */
export function makeStreamBuilder(opts: { autoCrop?: boolean } = {}): StreamBuilderService {
  const { autoCrop = false } = opts;
  return new StreamBuilderService(
    { getDetectedHwAccel: () => 'none' } as never,
    {
      getAutoCropEnabled: () => autoCrop,
      getTonemapAlgo: () => 'auto',
    } as never,
  );
}
