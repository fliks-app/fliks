import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

// Public repo (no token needed); overridable for forks / test repos.
const GITHUB_REPO = process.env.FLIKS_GITHUB_REPO ?? 'fliks-app/fliks';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
// Generous ceiling for a cold TLS handshake; the call is async + cached.
const FETCH_TIMEOUT_MS = 15000;

const CURRENT_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export interface UpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  releaseNotes: string | null;
  publishedAt: string | null;
}

interface GithubRelease {
  tag_name?: string;
  name?: string;
  html_url?: string;
  body?: string;
  published_at?: string;
  draft?: boolean;
  prerelease?: boolean;
}

/** "1.12.3" / "v1.12.3" → numeric parts, dropping any pre-release/build suffix. */
function parseVersion(raw: string | null | undefined): number[] | null {
  if (!raw) return null;
  const core = raw.trim().replace(/^v/i, '').split(/[-+]/)[0];
  const parts = core.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length === 0 || parts.some((n) => Number.isNaN(n))) return null;
  return parts;
}

function isNewer(latest: string | null, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const l = a[i] ?? 0;
    const c = b[i] ?? 0;
    if (l > c) return true;
    if (l < c) return false;
  }
  return false;
}

/** Tells whether a newer Fliks release than the running server exists, by
 *  polling the public GitHub releases API. Backs /system/update. */
@Injectable()
export class UpdateCheckService {
  private readonly logger = new Logger(UpdateCheckService.name);
  private cache: { status: UpdateStatus; fetchedAt: number } | null = null;

  get currentVersion(): string {
    return CURRENT_VERSION;
  }

  async getStatus(): Promise<UpdateStatus> {
    if (this.cache && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS) {
      return this.cache.status;
    }
    const status = await this.fetchStatus();
    // Don't cache a failed lookup, so the next call retries.
    if (status.latestVersion !== null) {
      this.cache = { status, fetchedAt: Date.now() };
    }
    return status;
  }

  private async fetchStatus(): Promise<UpdateStatus> {
    const fallback: UpdateStatus = {
      currentVersion: CURRENT_VERSION,
      latestVersion: null,
      updateAvailable: false,
      releaseUrl: null,
      releaseNotes: null,
      publishedAt: null,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'fliks-server',
          },
          signal: controller.signal,
        },
      );
      if (!res.ok) {
        this.logger.warn(`GitHub release lookup failed: HTTP ${res.status}`);
        return fallback;
      }
      const release = (await res.json()) as GithubRelease;
      if (release.draft) return fallback;

      const latestVersion = release.tag_name ?? release.name ?? null;
      return {
        currentVersion: CURRENT_VERSION,
        latestVersion,
        updateAvailable: isNewer(latestVersion, CURRENT_VERSION),
        releaseUrl: release.html_url ?? null,
        releaseNotes: release.body ?? null,
        publishedAt: release.published_at ?? null,
      };
    } catch (e) {
      this.logger.warn(
        `GitHub release lookup error: ${(e as Error).message}`,
      );
      return fallback;
    } finally {
      clearTimeout(timer);
    }
  }
}
