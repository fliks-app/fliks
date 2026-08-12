import { All, Controller, HttpStatus, Param, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtOrApiKeyGuard } from '../../auth/guards/jwt-or-api-key.guard';
import { PluginRegistryService } from '../plugin-registry.service';
import { PluginProcessService } from '../plugin-process.service';
import { PluginInstallException } from '../plugin-install.exception';
import { PluginRouteGuard, pluginRequestPath, type PluginRouteRequest } from './plugin-route.guard';
import type { User } from '../../users/entities/user.entity';

const CALL_DEADLINE_MS = 30_000;

/** Everything a data response needs, and nothing that steers the browser's session or
 *  navigation — a plugin must never be able to set `Set-Cookie`, `Location` or `Authorization`. */
const ALLOWED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  'content-type',
  'content-disposition',
  'cache-control',
  'etag',
  'last-modified',
]);

/** RFC 7230 token chars — rejects a header name a plugin could use to smuggle `\r\n` or a `:`. */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Node throws on these rather than emitting them, so an unchecked value is a plugin-triggerable 500. */
const HEADER_VALUE_FORBIDDEN_RE = /[\r\n\0]/;

function clampStatus(status: unknown): number {
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : HttpStatus.BAD_GATEWAY;
}

interface PluginHttpResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/** Shared with `PluginLegacyAliasController`: readiness check, the RPC call, and the same
 *  status-clamping/header-allowlisting tail — an alias's response must look exactly like a direct
 *  proxy call's. `path` is whatever the caller already resolved (the request's own remainder for
 *  a direct call, the substituted alias target for a legacy one). */
export async function forwardPluginCall(
  registry: PluginRegistryService,
  processService: PluginProcessService,
  pluginId: string,
  path: string,
  req: Request & { user?: User },
  res: Response,
): Promise<void> {
  const state = registry.processStateOf(pluginId);
  if (state !== 'ready') {
    throw new PluginInstallException(
      HttpStatus.SERVICE_UNAVAILABLE,
      'PLUGIN_UNAVAILABLE',
      `plugin "${pluginId}" is unavailable (${registry.processStatusMessageOf(pluginId) || state || 'not running'})`,
    );
  }

  const userId = req.user!.id;

  let result: PluginHttpResult;
  try {
    result = await processService.callPlugin<PluginHttpResult>(
      pluginId,
      'http',
      {
        method: req.method,
        path,
        query: req.query as Record<string, string>,
        body: req.body,
        principal: { kind: 'delegated', userId },
      },
      CALL_DEADLINE_MS,
    );
  } catch (err) {
    throw new PluginInstallException(HttpStatus.SERVICE_UNAVAILABLE, 'PLUGIN_UNAVAILABLE', (err as Error).message);
  }

  res.status(clampStatus(result.status));
  for (const [name, value] of Object.entries(result.headers ?? {})) {
    if (
      typeof value !== 'string' ||
      HEADER_VALUE_FORBIDDEN_RE.test(value) ||
      !HEADER_NAME_RE.test(name) ||
      !ALLOWED_RESPONSE_HEADERS.has(name.toLowerCase())
    ) {
      continue;
    }
    res.setHeader(name, value);
  }
  res.send(result.body);
}

/** The inbound half of a `process` plugin's routes. Mounted last in `plugins.module.ts`'s
 *  `controllers[]` so its `*splat` wildcard never shadows the concrete `plugins/*` routes above it. */
@Controller()
@UseGuards(JwtOrApiKeyGuard, PluginRouteGuard)
export class PluginProxyController {
  constructor(
    private readonly registry: PluginRegistryService,
    private readonly processService: PluginProcessService,
  ) {}

  @All('plugins/:pluginId/*splat')
  async proxy(@Param('pluginId') pluginId: string, @Req() req: PluginRouteRequest, @Res() res: Response): Promise<void> {
    // PluginRouteGuard already resolved the route and checked the policy/objectGuard;
    // this handler forwards the request's own path, never the declared pattern.
    await forwardPluginCall(this.registry, this.processService, pluginId, pluginRequestPath(req), req, res);
  }
}
