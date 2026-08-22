import { FieldDef } from '../plugin-contract/ui-contribution';

type SecretKeyed = Pick<FieldDef, 'key' | 'secret'>;

/** Names the secret fields that hold a stored value, so an editor can show `●●●●` without the
 *  value itself. Read-only: writes strip it back out rather than persisting it. */
export const SECRETS_SET_KEY = 'secretsSet';

/** Strips every `secret: true` field's value from `settings`, by schema key, and reports which
 *  of them are set under `SECRETS_SET_KEY`. */
export function redactSecretFields(
  settings: Record<string, unknown> | null | undefined,
  fields: readonly SecretKeyed[],
): Record<string, unknown> {
  const out = { ...(settings ?? {}) };
  const set: string[] = [];
  for (const field of fields) {
    if (!field.secret) continue;
    if (out[field.key]) set.push(field.key);
    delete out[field.key];
  }
  out[SECRETS_SET_KEY] = set;
  return out;
}

/** On write, keeps each secret field's stored value when the incoming one is absent or blank;
 *  an explicit `null` erases it, as JSON Merge Patch (RFC 7396) defines it. */
export function mergeSecretFields(
  existing: Record<string, unknown> | null | undefined,
  incoming: Record<string, unknown>,
  fields: readonly SecretKeyed[],
): Record<string, unknown> {
  const out = { ...incoming };
  delete out[SECRETS_SET_KEY];
  for (const field of fields) {
    if (!field.secret) continue;
    if (out[field.key] === null) delete out[field.key];
    else if (!out[field.key]) out[field.key] = (existing ?? {})[field.key];
  }
  return out;
}
