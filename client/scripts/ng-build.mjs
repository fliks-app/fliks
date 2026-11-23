// `ng build` with Angular's chunk optimizer off: it folds the whole initial graph into one 1.6 MB `main`, past the per-script budget.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const ng = join(dirname(createRequire(import.meta.url).resolve('@angular/cli/package.json')), 'bin', 'ng.js');
const { status } = spawnSync(process.execPath, [ng, 'build', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { NG_BUILD_OPTIMIZE_CHUNKS: '0', ...process.env },
});
process.exit(status ?? 1);
