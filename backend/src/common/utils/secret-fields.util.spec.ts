import { redactSecretFields, mergeSecretFields, SECRETS_SET_KEY } from './secret-fields.util';
import { FieldDef } from '../plugin-contract/ui-contribution';

const FIELDS: FieldDef[] = [
  { key: 'apiKey', type: 'text', labelKey: 'x', secret: true },
  { key: 'baseUrl', type: 'url', labelKey: 'x' },
];

describe('redactSecretFields', () => {
  it('strips only the fields the schema marks secret', () => {
    const out = redactSecretFields({ apiKey: 'k', baseUrl: 'https://x' }, FIELDS);
    expect(out).toEqual({ baseUrl: 'https://x', [SECRETS_SET_KEY]: ['apiKey'] });
  });

  it('reports a stripped secret as set, so an editor can mask it without holding it', () => {
    expect(redactSecretFields({ apiKey: 'k' }, FIELDS)[SECRETS_SET_KEY]).toEqual(['apiKey']);
    expect(redactSecretFields({ apiKey: '' }, FIELDS)[SECRETS_SET_KEY]).toEqual([]);
  });

  it('tolerates missing settings', () => {
    expect(redactSecretFields(undefined, FIELDS)).toEqual({ [SECRETS_SET_KEY]: [] });
  });
});

describe('mergeSecretFields', () => {
  it('keeps the stored secret when the incoming one is absent', () => {
    const out = mergeSecretFields({ apiKey: 'stored' }, { baseUrl: 'https://x' }, FIELDS);
    expect(out).toEqual({ baseUrl: 'https://x', apiKey: 'stored' });
  });

  it('keeps the stored secret when the incoming one is an empty string', () => {
    const out = mergeSecretFields({ apiKey: 'stored' }, { apiKey: '', baseUrl: 'https://x' }, FIELDS);
    expect(out.apiKey).toBe('stored');
  });

  it('writes a non-empty incoming secret over the stored one', () => {
    const out = mergeSecretFields({ apiKey: 'stored' }, { apiKey: 'new' }, FIELDS);
    expect(out.apiKey).toBe('new');
  });

  it('erases the stored secret when the incoming value is an explicit null', () => {
    const out = mergeSecretFields({ apiKey: 'stored' }, { apiKey: null, baseUrl: 'https://x' }, FIELDS);
    expect(out).toEqual({ baseUrl: 'https://x' });
    expect('apiKey' in out).toBe(false);
  });

  it('never persists the read-only set marker a client echoes back', () => {
    const out = mergeSecretFields({ apiKey: 'stored' }, { [SECRETS_SET_KEY]: ['apiKey'] }, FIELDS);
    expect(out).toEqual({ apiKey: 'stored' });
  });

  it('never touches a non-secret field beyond passing it through', () => {
    const out = mergeSecretFields({ baseUrl: 'stored-url' }, { baseUrl: '' }, FIELDS);
    expect(out.baseUrl).toBe('');
  });
});
