import { All, Controller, HttpStatus, Param, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtOrApiKeyGuard } from '../../auth/guards/jwt-or-api-key.guard';
import { PluginRegistryService } from '../plugin-registry.service';
import { PluginProcessService } from '../plugin-process.service';
import { PluginInstallException } from '../plugin-install.exception';
import { PluginRouteGuard, pluginRequestPath, type PluginRouteRequest } from './plugin-route.guard';

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
    const state = this.registry.processStateOf(pluginId);
    if (state !== 'ready') {
      throw new PluginInstallException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'PLUGIN_UNAVAILABLE',
        `plugin "${pluginId}" is unavailable (${this.registry.processStatusMessageOf(pluginId) || state || 'not running'})`,
      );
    }

    const userId = req.user!.id;

    let result: PluginHttpResult;
    try {
      result = await this.processService.callPlugin<PluginHttpResult>(
        pluginId,
        'http',
        {
          method: req.method,
          // PluginRouteGuard already resolved the route and checked the policy/objectGuard;
          // this forwards the request's own path, never the declared pattern.
          path: pluginRequestPath(req),
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
}
