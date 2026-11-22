import fs from 'node:fs';
import path from 'node:path';

/** Writes `content` to `target` through a rename, and only when it differs from what is there. */
export function writeFileAtomic(target: string, content: string): void {
  try {
    if (fs.readFileSync(target, 'utf8') === content) return;
  } catch {
    /* absent: written below */
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(`${target}.tmp`, content);
  fs.renameSync(`${target}.tmp`, target);
}
