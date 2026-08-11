import { ScheduledJobRegistry } from './scheduled-job-registry.service';

describe('ScheduledJobRegistry', () => {
  const job = (name: 'SearchMissing' | 'RssSync', triggerable = true) => ({
    name,
    cron: '*/15 * * * *',
    triggerable,
    run: jest.fn().mockResolvedValue(undefined),
  });

  it('lists nothing before anything registers — the download-bundle-off case', () => {
    const registry = new ScheduledJobRegistry();
    expect(registry.list()).toEqual([]);
    expect(registry.get('SearchMissing')).toBeUndefined();
  });

  it('lists every job a bundle registers, by reference', () => {
    const registry = new ScheduledJobRegistry();
    const jobs = [job('SearchMissing'), job('RssSync')];
    registry.register(jobs);
    expect(registry.list()).toHaveLength(2);
    expect(registry.get('SearchMissing')).toBe(jobs[0]);
    expect(registry.get('RssSync')).toBe(jobs[1]);
  });

  it('drops a non-triggerable job out of the triggerable-only view a caller builds', () => {
    const registry = new ScheduledJobRegistry();
    registry.register([job('SearchMissing', false)]);
    const triggerable = registry.list().filter((j) => j.triggerable);
    expect(triggerable).toHaveLength(0);
  });

  it('re-registering the same name replaces rather than duplicates it', () => {
    const registry = new ScheduledJobRegistry();
    registry.register([job('SearchMissing')]);
    const replacement = job('SearchMissing');
    registry.register([replacement]);
    expect(registry.list()).toHaveLength(1);
    expect(registry.get('SearchMissing')).toBe(replacement);
  });

  it('refuses a job named like a core scheduler job, fails closed, and still registers the rest of the batch', () => {
    const registry = new ScheduledJobRegistry();
    const core = { ...job('SearchMissing'), name: 'RefreshMetadata' };
    registry.register([core, job('RssSync')]);
    expect(registry.get('RefreshMetadata')).toBeUndefined();
    expect(registry.list().map((j) => j.name)).toEqual(['RssSync']);
  });
});
