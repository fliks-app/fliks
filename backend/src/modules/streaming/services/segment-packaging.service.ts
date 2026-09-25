import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { readAndRewriteCmaf } from '../transcoding/cmaf-rewrite';
import {
  parseInitTracks,
  rewriteSegmentTfdt,
  shiftSegmentTfdt,
  timelineOrigin,
} from '../transcoding/timeline';

/**
 * Turns an on-disk cache-dir segment into a wire-ready HLS response: TS verbatim,
 * fMP4/CMAF rewritten (sidx/styp stripped, hlsf brand stamped) and anchored onto
 * the single absolute presentation timeline so every rendition stays coherent
 * across resume / seek runs. Reads are buffered (not streamed) so an unlink
 * racing the read can't truncate the response (read-after-unlink safety). Owning
 * this here keeps the timeline/packaging logic out of the HTTP controller and
 * unit-testable without Express.
 */
@Injectable()
export class SegmentPackagingService {
  /** Track info per rendition cache dir, parsed once from its init segment.
   *  Cached only once populated so a cold-start race (init not yet flushed)
   *  retries on the next segment instead of caching an empty map. */
  private readonly initTrackCache = new Map<
    string,
    ReturnType<typeof parseInitTracks>
  >();

  /**
   * Serve a segment (or init) file onto `res`. `keyframeCut` is set for remux
   * (`-c:v copy`) output, whose segments follow the source keyframes rather
   * than the grid (#349), so it only gets the origin shift. `segDuration` is
   * the active HLS segment duration in seconds, threaded from the caller (the
   * StreamingSettingsCache-backed value) rather than a module global.
   */
  async serve(
    res: Response,
    filePath: string,
    contentType: string,
    opts: {
      segDuration: number;
      /** Source video `start_time`, the origin every run is anchored onto. */
      startPts?: number;
      keyframeCut?: boolean;
    },
  ): Promise<void> {
    // TS segments aren't fMP4/CMAF — the CMAF rewrite and tfdt anchoring are
    // no-ops on them, and running an ISO-BMFF box parser over MPEG-TS bytes is
    // meaningless. Read + serve verbatim, buffered for the same
    // read-after-unlink safety the fMP4 path relies on.
    if (filePath.endsWith('.ts')) {
      let tsBuf: Buffer;
      try {
        tsBuf = await fs.promises.readFile(filePath);
      } catch {
        if (!res.headersSent) res.status(404).end();
        return;
      }
      if (tsBuf.length === 0) {
        if (!res.headersSent) res.status(404).end();
        return;
      }
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', String(tsBuf.length));
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-store');
      res.end(tsBuf);
      return;
    }

    const buf = await readAndRewriteCmaf(filePath);
    if (!buf || buf.length === 0) {
      if (!res.headersSent) res.status(404).end();
      return;
    }
    const out = await this.anchorSegmentTimeline(
      filePath,
      buf,
      opts.segDuration,
      timelineOrigin(opts.startPts),
      opts.keyframeCut ?? false,
    );
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', String(out.length));
    res.setHeader('Access-Control-Allow-Origin', '*');
    // Cloudflare (and any intermediate CDN) will gladly cache a 0-byte 200
    // under the URL and serve it back for 4h by default — turning a transient
    // cold-start race into a session-killing permanent failure. Mark each fMP4
    // chunk un-cacheable so a CDN refusing the upstream length check never pins
    // a broken response.
    res.setHeader('Cache-Control', 'no-store');
    res.end(out);
  }

  /** Anchor a media segment onto the single absolute presentation timeline:
   *  rewrite its `tfdt` so `seg-N` decodes at its true presentation time
   *  `N · segDuration + origin` (per-track timescale), instead of FFmpeg's
   *  per-run 0-based reset. A keyframe-cut segment keeps its own times, moved
   *  by the origin. Init segments carry no `tfdt` and pass through unchanged. */
  private async anchorSegmentTimeline(
    filePath: string,
    buf: Buffer,
    segDuration: number,
    origin: number,
    keyframeCut: boolean,
  ): Promise<Buffer> {
    const m = /(?:^|\/)seg-(\d+)\.m4s$/.exec(filePath);
    if (!m) return buf;
    const tracks = await this.tracksForDir(path.dirname(filePath));
    if (tracks.size === 0) return buf;
    return keyframeCut
      ? shiftSegmentTfdt(buf, tracks, origin)
      : rewriteSegmentTfdt(buf, tracks, Number(m[1]), segDuration, origin);
  }

  private async tracksForDir(
    dir: string,
  ): Promise<ReturnType<typeof parseInitTracks>> {
    const cached = this.initTrackCache.get(dir);
    if (cached) return cached;
    let initBuf: Buffer | null = null;
    try {
      initBuf = await fs.promises.readFile(path.join(dir, 'init.mp4'));
    } catch {
      // var_stream_map renditions may name the init `init_<n>.mp4`.
      try {
        const entry = (await fs.promises.readdir(dir)).find((f) =>
          /^init.*\.mp4$/.test(f),
        );
        if (entry) initBuf = await fs.promises.readFile(path.join(dir, entry));
      } catch {
        return new Map();
      }
    }
    if (!initBuf) return new Map();
    const tracks = parseInitTracks(initBuf);
    if (tracks.size > 0) this.initTrackCache.set(dir, tracks);
    return tracks;
  }
}
