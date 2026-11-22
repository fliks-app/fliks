/// <reference types="node" />
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(process.cwd(), 'public', 'i18n');

function keys(obj: object, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

describe('i18n key parity', () => {
  const load = (f: string) => keys(JSON.parse(readFileSync(join(dir, f), 'utf8'))).sort();
  const en = load('en.json');

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'en.json')) {
    it(`${file} has exactly the keys of en.json`, () => {
      const got = load(file);
      expect(en.filter((k) => !got.includes(k))).toEqual([]);
      expect(got.filter((k) => !en.includes(k))).toEqual([]);
    });
  }
});
