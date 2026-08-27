// release-please reads commit messages with a stricter parser than commitlint
// (@conventional-commits/parser). A message it can't parse is dropped from the
// release — no error, exit 0 — so a feat silently stops bumping the minor and
// never reaches the changelog. Run the same parser here to make that loud.
//
// Usage: node check-commit-parse.mjs <git-range>
import { execFileSync } from 'node:child_process';
import { parser } from '@conventional-commits/parser';

const range = process.argv[2];
if (!range) {
  console.error('usage: check-commit-parse.mjs <git-range>');
  process.exit(2);
}

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

const shas = git('log', '--format=%H', range).split('\n').filter(Boolean);
let failed = 0;

for (const sha of shas) {
  const message = git('log', '-1', '--format=%B', sha);
  try {
    parser(message);
  } catch (e) {
    failed++;
    const reason = String(e.message).split('\n')[0];
    console.error(
      `::error::${sha.slice(0, 8)} ${git('log', '-1', '--format=%s', sha).trim()}\n` +
        `release-please cannot parse this message and would drop the commit: ${reason}`,
    );
  }
}

if (failed) {
  console.error(
    `\n${failed} of ${shas.length} commit message(s) would vanish from the release.\n` +
      'An unbalanced "(" in the body is enough — quote it or drop it, then amend.',
  );
  process.exit(1);
}

console.log(`${shas.length} commit message(s) parse cleanly.`);
