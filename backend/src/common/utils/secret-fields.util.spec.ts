import { redactSecretFields, mergeSecretFields } from './secret-fields.util';
import { FieldDef } from '../plugin-contract/ui-contribution';

const FIELDS: FieldDef[] = [
  { key: 'apiKey', type: 'text', labelKey: 'x', secret: true },
  { key: 'baseUrl', type: 'url', labelKey: 'x' },
];

describe('redactSecretFields', () => {
  it('strips only the fields the schema marks secret', () => {
    const out = redactSecretFields({ apiKey: 'k', baseUrl: 'https://x' }, FIELDS);
    expect(out).toEqual({ baseUrl: 'https://x' });
  });

  it('tolerates missing settings', () => {
    expect(redactSecretFields(undefined, FIELDS)).toEqual({});
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

  it('never touches a non-secret field beyond passing it through', () => {
    const out = mergeSecretFields({ baseUrl: 'stored-url' }, { baseUrl: '' }, FIELDS);
    expect(out.baseUrl).toBe('');
  });
});
