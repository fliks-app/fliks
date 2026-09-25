import type { FindOptionsWhere, Repository } from 'typeorm';
import { FieldDef, SECRETS_SET_KEY } from '../plugin-contract/ui-contribution';

type SecretKeyed = Pick<FieldDef, 'key' | 'secret'>;

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

/** On a test-connection call for a saved provider, resolves its stored secrets into `settings`
 *  (blank means untouched); `isCompatible` refuses the carry-over when the id names a different target. */
export async function resolveStoredSecrets<
  T extends { id: number; settings: Record<string, unknown> },
>(
  repo: Repository<T>,
  providerId: number | undefined,
  settings: Record<string, unknown>,
  fields: readonly SecretKeyed[],
  isCompatible?: (stored: T) => boolean,
): Promise<Record<string, unknown>> {
  if (providerId == null) return settings;
  const stored = await repo.findOne({
    where: { id: providerId } as FindOptionsWhere<T>,
  });
  if (stored && isCompatible && !isCompatible(stored)) return settings;
  return mergeSecretFields(stored?.settings, settings, fields);
}
