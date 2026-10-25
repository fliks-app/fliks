import { describe, expect, it } from 'vitest';
import { mediaKeyAction } from './media-keys';

describe('mediaKeyAction', () => {
  it('maps the standard key names', () => {
    expect(mediaKeyAction({ key: 'MediaPlayPause', keyCode: 179 })).toBe('toggle');
    expect(mediaKeyAction({ key: 'MediaStop', keyCode: 178 })).toBe('stop');
    expect(mediaKeyAction({ key: 'MediaFastForward', keyCode: 0 })).toBe('forward');
  });
  it('maps Tizen and webOS keyCodes without a key name', () => {
    expect(mediaKeyAction({ key: 'Unidentified', keyCode: 10252 })).toBe('toggle');
    expect(mediaKeyAction({ key: '', keyCode: 415 })).toBe('play');
    expect(mediaKeyAction({ key: '', keyCode: 19 })).toBe('pause');
    expect(mediaKeyAction({ key: '', keyCode: 413 })).toBe('stop');
    expect(mediaKeyAction({ key: '', keyCode: 417 })).toBe('forward');
    expect(mediaKeyAction({ key: '', keyCode: 412 })).toBe('rewind');
  });
  it('ignores other keys', () => {
    expect(mediaKeyAction({ key: 'a', keyCode: 65 })).toBeNull();
    expect(mediaKeyAction({ key: 'Enter', keyCode: 13 })).toBeNull();
  });
});
