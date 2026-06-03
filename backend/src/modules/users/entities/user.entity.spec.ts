import 'reflect-metadata';
import { readdirSync } from 'fs';
import { join } from 'path';
import { getMetadataArgsStorage } from 'typeorm';
import { instanceToPlain } from 'class-transformer';
import { User } from './user.entity';

/**
 * Credential columns must never reach an API response. The contract is
 * two-layered: `select: false` keeps the value out of every default load,
 * and `@Exclude` makes the global ClassSerializerInterceptor strip it from
 * any instance that was loaded explicitly. This spec enforces the contract
 * on every entity in the app, so adding a password column without both
 * locks fails CI.
 */

/** Imports every entity file so its decorators register their metadata. */
function loadAllEntities(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      loadAllEntities(full);
    } else if (entry.name.endsWith('.entity.ts')) {
      // The decorators only register on import; a static list would silently
      // skip newly added entities.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require(full);
    }
  }
}
loadAllEntities(join(__dirname, '../../..'));

// Restricted to `password` on purpose: `hash`/`token` would flag
// RefreshToken.tokenHash, which is a server-side lookup key that never
// serializes raw (auth responses are hand-mapped DTOs).
const SENSITIVE = /password/i;

// Name-matches the pattern but holds no secret material.
const NON_CREDENTIAL = new Set(['User.requirePasswordChange']);

describe('credential column hardening', () => {
  const sensitiveColumns = getMetadataArgsStorage().columns.filter(
    (c) =>
      SENSITIVE.test(c.propertyName) &&
      !NON_CREDENTIAL.has(
        `${(c.target as { name?: string }).name}.${c.propertyName}`,
      ),
  );

  it('covers User.passwordHash', () => {
    expect(
      sensitiveColumns.some(
        (c) => c.target === User && c.propertyName === 'passwordHash',
      ),
    ).toBe(true);
  });

  it('every password column is select: false', () => {
    const offenders = sensitiveColumns
      .filter((c) => c.options?.select !== false)
      .map((c) => `${(c.target as { name?: string }).name}.${c.propertyName}`);
    expect(offenders).toEqual([]);
  });

  it('every password column is stripped by serialization', () => {
    const offenders = sensitiveColumns
      .filter((c) => {
        const instance = new (c.target as new () => object)();
        (instance as Record<string, unknown>)[c.propertyName] =
          'sentinel-secret-value';
        return JSON.stringify(instanceToPlain(instance)).includes(
          'sentinel-secret-value',
        );
      })
      .map((c) => `${(c.target as { name?: string }).name}.${c.propertyName}`);
    expect(offenders).toEqual([]);
  });

  it('a serialized User carries no passwordHash', () => {
    const user = new User();
    Object.assign(user, {
      id: 1,
      username: 'someone',
      passwordHash: '$2b$12$secret-hash-value',
    });
    const plain = instanceToPlain(user);
    expect(plain).not.toHaveProperty('passwordHash');
    expect(JSON.stringify(plain)).not.toContain('secret-hash-value');
  });
});
