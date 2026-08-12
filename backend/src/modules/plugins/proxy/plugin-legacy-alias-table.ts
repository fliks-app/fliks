import { compile, match, type MatchFunction, type PathFunction } from 'path-to-regexp';

export interface LegacyAliasSpec {
  method: string;
  /** The URL core answers. */
  keyPath: string;
  /** The plugin's own route, built from `keyPath`'s captured params. */
  targetPath: string;
}

interface CompiledAlias {
  method: string;
  keyPath: string;
  matcher: MatchFunction<Record<string, string>>;
  buildTargetPath: PathFunction<Record<string, string>>;
}

/** One `process` manifest's `legacyPaths`, compiled once at `register()`. `PluginRegistryService`
 *  validates key/value shape and param-name agreement before any entry reaches this table. */
export class PluginLegacyAliasTable {
  private readonly compiled: CompiledAlias[];

  constructor(specs: readonly LegacyAliasSpec[]) {
    this.compiled = specs.map((spec) => ({
      method: spec.method.toUpperCase(),
      keyPath: spec.keyPath,
      matcher: match<Record<string, string>>(spec.keyPath),
      buildTargetPath: compile<Record<string, string>>(spec.targetPath),
    }));
  }

  /** The plugin's own path with `path`'s captured params substituted in, or `null` — no
   *  declared alias matches, same refusal semantics as `PluginRouteTable.resolve`. */
  resolve(method: string, path: string): string | null {
    const wanted = method.toUpperCase();
    for (const entry of this.compiled) {
      if (entry.method !== wanted) continue;
      const result = entry.matcher(path);
      if (result === false) continue;
      return entry.buildTargetPath(result.params);
    }
    return null;
  }

  /** `"METHOD keyPath"` for every alias this table owns — used only to detect a key
   *  another installed plugin already claims. */
  keys(): string[] {
    return this.compiled.map((entry) => `${entry.method} ${entry.keyPath}`);
  }
}
