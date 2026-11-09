/** Semver order: numeric core, then a pre-release below its release, identifiers numeric when both are. */
export function compareVersions(a: string, b: string): number {
  const [coreA, preA] = split(a);
  const [coreB, preB] = split(b);
  for (let i = 0; i < 3; i++) {
    const d = (coreA[i] ?? 0) - (coreB[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (!preA.length || !preB.length) return preA.length ? -1 : preB.length ? 1 : 0;
  for (let i = 0; i < Math.max(preA.length, preB.length); i++) {
    const x = preA[i];
    const y = preB[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Math.sign(Number(x) - Number(y));
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function split(v: string): [number[], string[]] {
  const [core, pre] = v.replace(/^v/, '').split('+')[0].split(/-(.*)/s);
  return [core.split('.').map(Number), pre ? pre.split('.') : []];
}
