import { describe, expect, it } from 'vitest';
import { systemText } from './party-system-message';

const fmt = { position: (s: number) => `t${s}`, when: (iso: string) => `at ${iso}` };
const run = (kind: string, args: Record<string, unknown> = {}) => systemText({ kind, by: 'ann', args }, fmt);

describe('systemText', () => {
  it('keeps plain kinds and formats the position', () => {
    expect(run('paused').key).toBe('party.system.paused');
    expect(run('seeked', { position: 61 }).params['position']).toBe('t61');
  });

  it('hides the title the viewer cannot open', () => {
    expect(run('item_skipped', { title: '' }).key).toBe('party.system.item_skipped_hidden');
    expect(run('item_changed', { title: '' }).key).toBe('party.system.item_changed_hidden');
    expect(run('voted', { value: -1, title: '' }).key).toBe('party.system.voted_hidden');
    expect(run('item_changed', { title: 'X' }).key).toBe('party.system.item_changed');
  });

  it('maps each setting and value to its own key', () => {
    expect(run('setting_changed', { setting: 'policy', value: 'host_only' }).key).toBe('party.system.setting_policy_host_only');
    expect(run('setting_changed', { setting: 'chatEnabled', value: false }).key).toBe('party.system.setting_chatEnabled_off');
    expect(run('setting_changed', { setting: 'public', value: true }).key).toBe('party.system.setting_public_on');
  });

  it('formats rename, reschedule and people', () => {
    expect(run('renamed', { name: 'N' }).params['name']).toBe('N');
    expect(run('rescheduled', { scheduledAt: 'D' }).params['when']).toBe('at D');
    expect(run('people_added', { usernames: ['a', 'b'] }).params['names']).toBe('a, b');
  });

  it('splits proposals and votes', () => {
    expect(run('proposed', { count: 1, title: 'X' }).key).toBe('party.system.proposed');
    const many = run('proposed', { count: 3, title: '' });
    expect(many.key).toBe('party.system.proposed_many');
    expect(many.params['count']).toBe(3);
    expect(run('voted', { value: 1, title: 'X' }).key).toBe('party.system.voted_up');
    expect(run('voted', { value: -1, title: 'X' }).key).toBe('party.system.voted_down');
  });

  it('shows only the non-zero programme parts', () => {
    expect(run('programme_changed', { added: 2, removed: 0 }).key).toBe('party.system.programme_changed_added');
    expect(run('programme_changed', { added: 0, removed: 1 }).key).toBe('party.system.programme_changed_removed');
    expect(run('programme_changed', { added: 1, removed: 1 }).key).toBe('party.system.programme_changed_added_removed');
    expect(run('programme_changed', { added: 0, removed: 0 }).key).toBe('party.system.programme_changed');
  });
});
