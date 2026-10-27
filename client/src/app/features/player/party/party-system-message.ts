import type { PartyMessage } from '../../../core/services/api/party-api.service';

type System = NonNullable<PartyMessage['system']>;

export interface SystemText {
  key: string;
  params: Record<string, unknown>;
}

/** Maps a system message to its `party.system.*` key and params; `position` and `when` format the time-like args. */
export function systemText(sys: System, fmt: { position: (s: number) => string; when: (iso: string) => string }): SystemText {
  const a = sys.args ?? {};
  const title = typeof a['title'] === 'string' ? a['title'] : '';
  const params: Record<string, unknown> = { by: sys.by ?? '', title, name: a['name'], added: a['added'], removed: a['removed'] };
  if (typeof a['position'] === 'number') params['position'] = fmt.position(a['position']);
  if (typeof a['scheduledAt'] === 'string') params['when'] = fmt.when(a['scheduledAt']);
  if (Array.isArray(a['usernames'])) params['names'] = a['usernames'].join(', ');

  let kind: string = sys.kind;
  if (kind === 'setting_changed') kind = `setting_${a['setting']}_${typeof a['value'] === 'boolean' ? (a['value'] ? 'on' : 'off') : a['value']}`;
  else if (kind === 'voted') kind = a['value'] === 1 ? 'voted_up' : 'voted_down';
  else if (kind === 'proposed' && Number(a['count']) > 1) {
    kind = 'proposed_many';
    params['count'] = a['count'];
  } else if (kind === 'programme_changed') {
    const parts = [a['added'] ? 'added' : '', a['removed'] ? 'removed' : ''].filter(Boolean);
    if (parts.length) kind = `programme_changed_${parts.join('_')}`;
  }

  // An empty title means the viewer cannot open the media.
  const hidden = 'title' in a && !title && kind !== 'proposed_many';
  return { key: `party.system.${hidden ? `${sys.kind}_hidden` : kind}`, params };
}
