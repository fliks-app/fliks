import { FieldDef } from '../plugin-contract/ui-contribution';

type SecretKeyed = Pick<FieldDef, 'key' | 'secret'>;

/** Strips every `secret: true` field's value from `settings`, by schema key. */
export function redactSecretFields(
  settings: Record<string, unknown> | null | undefined,
  fields: readonly SecretKeyed[],
): Record<string, unknown> {
  const out = { ...(settings ?? {}) };
  for (const field of fields) {
    if (field.secret) delete out[field.key];
  }
  return out;
}

/** On write, keeps each secret field's stored value when the incoming one is absent/empty. */
export function mergeSecretFields(
  existing: Record<string, unknown> | null | undefined,
  incoming: Record<string, unknown>,
  fields: readonly SecretKeyed[],
): Record<string, unknown> {
  const out = { ...incoming };
  for (const field of fields) {
    if (!field.secret) continue;
    if (!out[field.key]) out[field.key] = (existing ?? {})[field.key];
  }
  return out;
}
