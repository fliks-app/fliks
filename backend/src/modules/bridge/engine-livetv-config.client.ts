import { Injectable } from '@nestjs/common';
import type { LiveTvConfig } from '../engine/engine.service';

/** Hands the live TV settings to fliks-server, which pushes the engine's config (bridge `PUT /internal/engine/livetv-config`). */
@Injectable()
export class EngineLivetvConfigClient {
  async put(config: LiveTvConfig): Promise<void> {
    const base = process.env.FLIKS_SERVER_URL;
    const token = process.env.FLIKS_BRIDGE_TOKEN;
    if (!base || !token) throw new Error('livetv-config bridge not configured');
    const res = await fetch(`${base}/internal/engine/livetv-config`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(config),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`livetv-config bridge answered ${res.status}`);
  }
}
