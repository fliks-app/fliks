import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { SettingsService } from '../../modules/settings/settings.service';

/**
 * Parse a CIDR notation string into a numeric base and mask.
 * Returns null if the format is invalid.
 */
function parseCidr(cidr: string): { base: number; mask: number } | null {
  const parts = cidr.trim().split('/');
  if (parts.length !== 2) return null;
  const ip = ipToNumber(parts[0]);
  const bits = parseInt(parts[1], 10);
  if (ip == null || isNaN(bits) || bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return { base: (ip & mask) >>> 0, mask };
}

function ipToNumber(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let num = 0;
  for (const p of parts) {
    const n = parseInt(p, 10);
    if (isNaN(n) || n < 0 || n > 255) return null;
    num = (num << 8) | n;
  }
  return num >>> 0;
}

function ipMatchesCidr(ip: string, cidrs: string[]): boolean {
  // Strip IPv6-mapped IPv4 prefix (::ffff:)
  const cleanIp = ip.replace(/^::ffff:/, '');
  const num = ipToNumber(cleanIp);
  if (num == null) return false;

  for (const cidr of cidrs) {
    const parsed = parseCidr(cidr);
    if (parsed && (num & parsed.mask) >>> 0 === parsed.base) return true;
  }
  return false;
}

/** Routes that Chromecast devices call directly (token-protected). */
function isCastRoute(url: string): boolean {
  return (
    url.startsWith('/api/stream/') ||
    url.startsWith('/api/images/') ||
    url.startsWith('/api/auth/cast-info')
  );
}

const SETTINGS_CACHE_MS = 5_000; // Re-read settings every 5s max

@Injectable()
export class IpWhitelistMiddleware implements NestMiddleware {
  private readonly log = new Logger(IpWhitelistMiddleware.name);

  // In-memory cache to avoid hitting the DB on every request
  private cachedEnabled: string | null = null;
  private cachedRanges: string[] = [];
  private cachedPendingUntil: string | null = null;
  private cachedExposeCast = false;
  private lastFetch = 0;

  constructor(private readonly settings: SettingsService) {}

  async use(req: Request, res: Response, next: NextFunction) {
    // Always allow settings routes (so admin can disable if locked out)
    const url = req.originalUrl ?? req.url;
    if (
      url.startsWith('/api/settings/ip_whitelist') ||
      url === '/api/settings' ||
      url.startsWith('/api/auth/login')
    ) {
      return next();
    }

    await this.refreshCache();

    // Disabled → pass everything
    if (!this.cachedEnabled || this.cachedEnabled === 'false') {
      return next();
    }

    // Pending state — check if confirmation expired
    if (this.cachedEnabled === 'pending') {
      if (this.cachedPendingUntil) {
        const deadline = new Date(this.cachedPendingUntil).getTime();
        if (Date.now() > deadline) {
          // Auto-revert: user didn't confirm in time
          this.log.warn('IP whitelist pending confirmation expired — reverting to disabled');
          await this.settings.set('ip_whitelist_enabled', 'false');
          await this.settings.delete('ip_whitelist_pending_until');
          this.cachedEnabled = 'false';
          this.cachedPendingUntil = null;
          return next();
        }
      }
      // During pending, enforce the whitelist (to test if it works)
    }

    // Allow Chromecast routes if expose_cast is enabled
    if (this.cachedExposeCast && isCastRoute(url)) {
      return next();
    }

    // Check client IP against allowed ranges
    const clientIp = req.ip ?? req.socket.remoteAddress ?? '';
    if (this.cachedRanges.length === 0 || ipMatchesCidr(clientIp, this.cachedRanges)) {
      return next();
    }

    this.log.warn(`Blocked request from ${clientIp} to ${url}`);
    res.status(403).json({ statusCode: 403, message: 'Access denied: IP not allowed' });
  }

  private async refreshCache() {
    if (Date.now() - this.lastFetch < SETTINGS_CACHE_MS) return;
    this.lastFetch = Date.now();

    try {
      const [enabled, ranges, pending, exposeCast] = await Promise.all([
        this.settings.get('ip_whitelist_enabled'),
        this.settings.get('ip_whitelist_ranges'),
        this.settings.get('ip_whitelist_pending_until'),
        this.settings.get('ip_whitelist_expose_cast'),
      ]);

      this.cachedEnabled = enabled;
      this.cachedPendingUntil = pending;
      this.cachedExposeCast = exposeCast === 'true';

      try {
        this.cachedRanges = ranges ? JSON.parse(ranges) : [];
      } catch {
        this.cachedRanges = [];
      }
    } catch {
      // DB error — fail open (don't block)
      this.cachedEnabled = 'false';
    }
  }
}
