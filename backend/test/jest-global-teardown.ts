import { rmSync } from 'fs';

export default () => {
  rmSync(process.env.FLIKS_TEST_TMP_BASE!, { recursive: true, force: true });
};
