import {
  StreamBuilderService,
  type EvaluateInput,
  type EvaluateResult,
  type EvaluateSettings,
} from './stream-builder.service';
import { DEFAULT_SEGMENT_DURATION } from './transcoding/constants';
import type { HwAccelType } from './transcoding/types';

type SettingsOverride = Partial<EvaluateSettings>;
type RecordedEvaluate = (input: EvaluateInput, result: EvaluateResult) => void;

/** Set by test/engine-vectors to capture every evaluate() a spec runs. */
export const evaluateRecorder: { current?: RecordedEvaluate } = {};

/** StreamBuilderService on fake dependencies (no HW accel unless asked), whose
 *  evaluate() fills in the admin settings: no tone-map override, crop off unless asked. */
export function makeStreamBuilder(
  opts: { autoCrop?: boolean; hwAccel?: HwAccelType } = {},
): {
  evaluate(
    input: Omit<EvaluateInput, 'settings'> & { settings?: SettingsOverride },
  ): EvaluateResult;
} {
  const svc = new StreamBuilderService({
    getDetectedHwAccel: () => opts.hwAccel ?? 'none',
  } as never);
  const defaults: EvaluateSettings = {
    autoCropEnabled: opts.autoCrop ?? false,
    tonemapAlgo: 'auto',
    autoQualityMode: 'directplay',
    segmentDuration: DEFAULT_SEGMENT_DURATION,
  };
  return {
    evaluate: (input) => {
      const full = { ...input, settings: { ...defaults, ...input.settings } };
      const result = svc.evaluate(full);
      evaluateRecorder.current?.(full, result);
      return result;
    },
  };
}
