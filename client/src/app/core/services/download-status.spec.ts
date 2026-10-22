import { describe, expect, it } from 'vitest';
import { DOWNLOAD_STATUSES, heldStatus, isActive, isPausable, isTransferring, normalizeStatus, nothingStartedKey } from './download-status';

describe('download status', () => {
  it('maps the statuses saved before the union onto it', () => {
    expect(normalizeStatus('transcoding')).toBe('preparing');
    expect(normalizeStatus('pending')).toBe('preparing');
    for (const s of DOWNLOAD_STATUSES) expect(normalizeStatus(s)).toBe(s);
  });

  it('reads an unknown status as failed so the row stays deletable', () => {
    expect(normalizeStatus('bogus')).toBe('failed');
    expect(normalizeStatus(undefined)).toBe('failed');
  });

  it('classifies every status', () => {
    expect(DOWNLOAD_STATUSES.filter(isActive)).toEqual(['preparing', 'queued', 'downloading', 'paused', 'waiting_wifi']);
    expect(DOWNLOAD_STATUSES.filter(isPausable)).toEqual(['preparing', 'queued', 'downloading']);
    expect(DOWNLOAD_STATUSES.filter(isTransferring)).toEqual(['preparing', 'downloading']);
  });

  it('names the held states a native event can report', () => {
    expect(heldStatus('paused')).toBe('paused');
    expect(heldStatus('waiting_wifi')).toBe('waiting_wifi');
    expect(heldStatus('queued')).toBe('queued');
    expect(heldStatus('downloading')).toBeNull();
  });

  it('names an all-on-device batch apart from the other no-ops', () => {
    expect(nothingStartedKey(3, 3)).toBe('downloads.already_downloaded');
    expect(nothingStartedKey(1, 3)).toBe('downloads.nothing_new');
    expect(nothingStartedKey(0, 0)).toBe('downloads.nothing_new');
  });
});
