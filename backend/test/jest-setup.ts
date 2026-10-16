import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Installed and staged plugin files live under one runtime directory, and an uninstall removes its
// tree: without a per-worker path, parallel workers delete each other's fixtures.
process.env.FLIKS_RUNTIME_DIR ??= mkdtempSync(
  join(process.env.FLIKS_TEST_TMP_BASE ?? tmpdir(), `${process.env.JEST_WORKER_ID ?? '0'}-`),
);
