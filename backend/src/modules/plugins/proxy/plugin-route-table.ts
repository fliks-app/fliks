import { match, type MatchFunction } from 'path-to-regexp';
import type { PluginRoute } from '../../../common/plugin-contract';

export interface ResolvedPluginRoute {
  route: PluginRoute;
  params: Record<string, string>;
}

interface CompiledRoute {
  method: string;
  route: PluginRoute;
  matcher: MatchFunction<Record<string, string>>;
}

/** One `process` manifest's `routes[]`, compiled once at `register()` — never per request.
 *  `match()` is case-insensitive on the path by default; left as-is, Express matches app-wide the same way. */
export class PluginRouteTable {
  private readonly compiled: CompiledRoute[];

  constructor(routes: readonly PluginRoute[]) {
    this.compiled = routes.map((route) => ({
      method: route.method.toUpperCase(),
      route,
      matcher: match<Record<string, string>>(route.path),
    }));
  }

  /** No match — wrong method, unknown path, or a param that fails the pattern (e.g. an empty
   *  capture) — is `null`, a refusal rather than "no route declared". */
  resolve(method: string, path: string): ResolvedPluginRoute | null {
    const wanted = method.toUpperCase();
    for (const entry of this.compiled) {
      if (entry.method !== wanted) continue;
      const result = entry.matcher(path);
      if (result === false) continue;
      return { route: entry.route, params: result.params };
    }
    return null;
  }
}
