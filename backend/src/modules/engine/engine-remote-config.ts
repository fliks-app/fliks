export const ENGINE_URL_KEY = 'engine_url';
export const ENGINE_TOKEN_KEY = 'engine_token';

function origin(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** A saved URL and `FLIKS_ENGINE_URL` name two engines. Video follows the process one. */
export function engineUrlsDiffer(saved: string, processUrl: string): boolean {
  const a = origin(saved);
  const b = origin(processUrl);
  return a !== '' && b !== '' && a !== b;
}
