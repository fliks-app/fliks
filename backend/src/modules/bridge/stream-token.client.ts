import { Injectable } from '@nestjs/common';

/** Mints a stream token through fliks-server (S1 bridge `/internal/auth/stream-token`): one signer. */
@Injectable()
export class StreamTokenClient {
  async mint(userId: number): Promise<string> {
    const base = process.env.FLIKS_SERVER_URL;
    const token = process.env.FLIKS_BRIDGE_TOKEN;
    if (!base || !token) throw new Error('stream-token bridge not configured');
    const res = await fetch(`${base}/internal/auth/stream-token`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ userId }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`stream-token bridge answered ${res.status}`);
    return ((await res.json()) as { streamToken: string }).streamToken;
  }
}
