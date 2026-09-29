import * as path from 'path';

/** Bonus-clip folders inside a title's folder; a scan-root child of that name is a title. */
const BONUS_DIR_RE =
  /^(samples?|extras?|featurettes?|trailers?|interviews|behind[ ._-]the[ ._-]scenes|deleted[ ._-]scenes)$/i;
/** A release's sample clip ends with a `sample` token; a title merely starting with it does not. */
const SAMPLE_FILE_RE = /(?:^|[.\-_ ])sample$/i;

export function isBonusDir(dirName: string): boolean {
  return BONUS_DIR_RE.test(dirName);
}

export function isSampleFile(filename: string): boolean {
  return SAMPLE_FILE_RE.test(path.basename(filename, path.extname(filename)));
}
