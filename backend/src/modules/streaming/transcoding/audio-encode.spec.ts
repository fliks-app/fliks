jest.mock('./audio-encoder-probe', () => ({
  isLibfdkAacEnabled: jest.fn(() => false),
}));

import {
  audioEncoderName,
  encodedPacketGrid,
  encoderMaxChannels,
} from './audio-encode';
import { isLibfdkAacEnabled } from './audio-encoder-probe';

const libfdkEnabled = isLibfdkAacEnabled as jest.Mock;

describe('audioEncoderName', () => {
  beforeEach(() => libfdkEnabled.mockReturnValue(false));

  it('falls back to native aac when the probe found no libfdk_aac', () => {
    expect(audioEncoderName('aac', 2)).toBe('aac');
    expect(audioEncoderName('aac', 6)).toBe('aac');
  });

  it('picks libfdk_aac for stereo/5.1 once the probe finds it', () => {
    libfdkEnabled.mockReturnValue(true);
    expect(audioEncoderName('aac', 2)).toBe('libfdk_aac');
    expect(audioEncoderName('aac', 6)).toBe('libfdk_aac');
  });

  it('keeps native aac for 7.1/8ch even when libfdk_aac is available', () => {
    libfdkEnabled.mockReturnValue(true);
    expect(audioEncoderName('aac', 8)).toBe('aac');
  });

  it('never touches non-AAC codecs', () => {
    libfdkEnabled.mockReturnValue(true);
    expect(audioEncoderName('ac3', 6)).toBe('ac3');
    expect(audioEncoderName('eac3', 6)).toBe('eac3');
    expect(audioEncoderName('opus', 8)).toBe('libopus');
  });
});

describe('encoderMaxChannels', () => {
  it('keeps the codec-level ceiling regardless of which binary a run picks', () => {
    expect(encoderMaxChannels('aac')).toBe(8);
    expect(encoderMaxChannels('ac3')).toBe(6);
    expect(encoderMaxChannels('eac3')).toBe(6);
    expect(encoderMaxChannels('opus')).toBe(8);
  });
});

describe('encodedPacketGrid', () => {
  beforeEach(() => libfdkEnabled.mockReturnValue(false));

  it('lands the same 1024-sample grid switching encoder for AAC', () => {
    libfdkEnabled.mockReturnValue(false);
    const native = encodedPacketGrid('aac', 2);
    libfdkEnabled.mockReturnValue(true);
    const fdk = encodedPacketGrid('aac', 2);
    expect(native.frame).toBeCloseTo(1024 / 48_000);
    expect(fdk.frame).toBeCloseTo(1024 / 48_000);
  });

  it('resolves the 8-channel case to the native grid even when libfdk is available', () => {
    libfdkEnabled.mockReturnValue(false);
    const native = encodedPacketGrid('aac', 8);
    libfdkEnabled.mockReturnValue(true);
    expect(encodedPacketGrid('aac', 8)).toEqual(native);
  });
});
