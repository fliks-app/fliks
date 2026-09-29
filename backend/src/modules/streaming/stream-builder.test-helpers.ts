import {
  StreamBuilderService,
  type EvaluateInput,
  type EvaluateResult,
  type EvaluateSettings,
} from './stream-builder.service';
import { DEFAULT_SEGMENT_DURATION } from './transcoding/constants';

/** StreamBuilderService on fake dependencies (no HW accel), whose evaluate()
 *  fills in the admin settings: no tone-map override, crop off unless asked. */
export function makeStreamBuilder(opts: { autoCrop?: boolean } = {}): {
  evaluate(
    input: Omit<EvaluateInput, 'settings'> & { settings?: Partial<EvaluateSettings> },
  ): EvaluateResult;
} {
  const svc = new StreamBuilderService({ getDetectedHwAccel: () => 'none' } as never);
  const defaults: EvaluateSettings = {
    autoCropEnabled: opts.autoCrop ?? false,
    tonemapAlgo: 'auto',
    autoQualityMode: 'directplay',
    segmentDuration: DEFAULT_SEGMENT_DURATION,
  };
  return {
    evaluate: (input) =>
      svc.evaluate({ ...input, settings: { ...defaults, ...input.settings } }),
  };
}
