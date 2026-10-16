import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Env set here reaches the workers; the teardown removes this base and every dir under it.
export default () => {
  process.env.FLIKS_TEST_TMP_BASE = mkdtempSync(join(tmpdir(), 'fliks-test-'));
};
