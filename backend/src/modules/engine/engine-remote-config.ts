export const ENGINE_URL_KEY = 'engine_url';
export const ENGINE_TOKEN_KEY = 'engine_token';
export const ENGINE_PATH_MAPPINGS_KEY = 'engine_path_mappings';

export type EnginePathMapping = { from: string; to: string };

export function parsePathMappings(raw: string | null | undefined): EnginePathMapping[] {
  if (!raw?.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (m): m is EnginePathMapping =>
          !!m &&
          typeof m === 'object' &&
          typeof (m as EnginePathMapping).from === 'string' &&
          typeof (m as EnginePathMapping).to === 'string',
      )
      .map((m) => ({ from: m.from.trim(), to: m.to.trim() }))
      .filter((m) => m.from && m.to);
  } catch {
    return [];
  }
}

export function sanitizePathMappings(
  mappings: EnginePathMapping[],
): EnginePathMapping[] {
  return mappings
    .map((m) => ({ from: m.from.trim(), to: m.to.trim() }))
    .filter((m) => m.from && m.to);
}
