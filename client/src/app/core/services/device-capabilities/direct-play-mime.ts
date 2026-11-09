/** The MIME of a raw progressive file by the container the server probed (`matroska,webm`, `mov,mp4,m4a,3gp,3g2,mj2`...), for an engine that opens it by type. */
export function directPlayMime(container: string | undefined): string {
  const c = (container ?? '').toLowerCase();
  if (c.includes('matroska') || c === 'mkv') return 'video/x-matroska';
  if (c.includes('webm')) return 'video/webm';
  if (c.includes('mpegts') || c === 'ts' || c === 'm2ts') return 'video/mp2t';
  return 'video/mp4';
}
