import { LivenessController } from './liveness.controller';

describe('LivenessController', () => {
  it('carries no guard metadata and returns ok', () => {
    expect(Reflect.getMetadata('__guards__', LivenessController)).toBeUndefined();
    expect(new LivenessController().liveness()).toEqual({ ok: true });
  });
});
