export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Storage failures keep the value for this session. */
export function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // storage unavailable
  }
}

export function readFlag(key: string, fallback: boolean): boolean {
  const v = readStored(key);
  return v === null ? fallback : v === '1';
}

export function writeFlag(key: string, on: boolean): void {
  writeStored(key, on ? '1' : '0');
}
