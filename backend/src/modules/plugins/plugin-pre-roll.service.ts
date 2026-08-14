import { Injectable, Logger } from '@nestjs/common';
import { PluginRegistryService } from './plugin-registry.service';
import { PluginProcessService } from './plugin-process.service';
import { PLUGIN_DEADLINES_MS, PRE_ROLL_ITEMS_MAX, type Principal, type PreRollItem } from '../../common/plugin-contract';

/** Own, short deadline — playback-info sits on the critical path of pressing play. */
const PRE_ROLL_CALL_DEADLINE_MS = PLUGIN_DEADLINES_MS.healthReply;

export interface PreRollAsk {
  mediaFileId: number;
  mediaId: number;
  episodeId?: number;
  principal: Principal;
}

interface PluginHttpResult {
  status: number;
  body: unknown;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/** Validates and caps whatever a plugin's route answered — untrusted JSON, so nothing here
 *  is assumed to have the declared shape. Anything not a well-formed item is dropped, as is
 *  the main item itself and any repeat: both would play the same file twice. */
function sanitizeItems(body: unknown, mainMediaFileId: number): PreRollItem[] {
  if (!Array.isArray(body)) return [];
  const out: PreRollItem[] = [];
  const seen = new Set<number>([mainMediaFileId]);
  for (const entry of body) {
    if (out.length >= PRE_ROLL_ITEMS_MAX) break;
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (!isPositiveInt(e.mediaFileId) || seen.has(e.mediaFileId)) continue;
    seen.add(e.mediaFileId);
    const item: PreRollItem = { mediaFileId: e.mediaFileId };
    if (typeof e.labelKey === 'string') item.labelKey = e.labelKey;
    if (typeof e.skippable === 'boolean') item.skippable = e.skippable;
    out.push(item);
  }
  return out;
}

/** Asks the winning `ui.player` plugin for pre-roll candidates. Never throws: no declaring
 *  plugin, a stopped/failed/timed-out call, a non-200, or a malformed body all answer `[]`. */
@Injectable()
export class PluginPreRollService {
  private readonly logger = new Logger(PluginPreRollService.name);

  constructor(
    private readonly registry: PluginRegistryService,
    private readonly processService: PluginProcessService,
  ) {}

  async ask(params: PreRollAsk): Promise<PreRollItem[]> {
    const winner = this.registry.preRollRoute();
    if (!winner) return [];

    let result: PluginHttpResult;
    try {
      result = await this.processService.callPlugin<PluginHttpResult>(
        winner.pluginId,
        'http',
        {
          method: 'POST',
          path: winner.route,
          query: {},
          body: { mediaFileId: params.mediaFileId, mediaId: params.mediaId, episodeId: params.episodeId },
          principal: params.principal,
        },
        PRE_ROLL_CALL_DEADLINE_MS,
      );
    } catch (err) {
      this.logger.warn(`pre-roll call to "${winner.pluginId}" failed: ${(err as Error).message}`);
      return [];
    }

    if (result.status !== 200) return [];
    return sanitizeItems(result.body, params.mediaFileId);
  }
}
