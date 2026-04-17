import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { Episode } from '../media/entities/episode.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { Media } from '../media/entities/media.entity';
import { Season } from '../media/entities/season.entity';
import { EpisodeMarker } from './entities/episode-marker.entity';
import { SettingsService } from '../settings/settings.service';

const execFileAsync = promisify(execFile);

interface Fingerprint {
  /** Raw int32 chromaprint hashes (~8 per second by default). */
  hashes: number[];
  /** Actual seconds covered by the fingerprint (from fpcalc DURATION line). */
  durationSeconds: number;
  /** Absolute file offset (seconds) where this fingerprint starts. Used
   *  to convert sample positions back to absolute file timestamps when
   *  scanning windows other than the file head (e.g. the outro zone). */
  baseOffsetSec: number;
}

interface MatchResult {
  /** Sample index in the first fingerprint where the matching segment starts. */
  aStart: number;
  /** Sample index in the second fingerprint where the matching segment starts. */
  bStart: number;
  /** Length of the matching segment in samples. */
  length: number;
  /** Average Hamming distance (lower = better). */
  hammingAvg: number;
}

interface DetectionResult {
  episodeId: number;
  startSeconds: number;
  endSeconds: number;
  confidence: number;
}

/**
 * Detects show intros by audio fingerprinting (chromaprint / fpcalc) and
 * matching common segments across episodes of a season.
 *
 * Inspired by Jellyfin's Intro Skipper plugin (MIT). The core idea: every
 * episode of a season shares the same intro music — fingerprint the first
 * `MAX_LOOKUP_MINUTES` of audio for each episode, then for each episode find
 * the longest matching segment against its peers. That segment is the intro.
 */
@Injectable()
export class IntroDetectionService {
  private readonly log = new Logger(IntroDetectionService.name);

  // Algorithm constants
  /** Hamming-distance threshold (out of 32 bits) below which two hashes are considered a match. */
  private static readonly HAMMING_THRESHOLD = 6;
  /** Maximum offset (in samples) between episodes for the intro alignment.
   *  Intros can sit at very different positions across episodes of the same
   *  season (variable cold opens) — 3 min covers almost everything. Cost is
   *  linear in this value (~1440 × 4800 ops per pair = ~7M, still fast). */
  private static readonly MAX_LAG_SAMPLES = 1440; // ~180s
  /** Default minimum intro length in seconds (overridable via settings). */
  private static readonly DEFAULT_MIN_SEGMENT_SECONDS = 15;
  /** Default fingerprint window in minutes (overridable via settings). */
  private static readonly DEFAULT_MAX_LOOKUP_MINUTES = 10;
  /** Reject candidate matches longer than this — typical intros are 30–90s, anything
   *  above is likely a recurring action montage / leitmotiv that just happens to repeat. */
  private static readonly MAX_PLAUSIBLE_INTRO_SECONDS = 120;
  /** Reject candidate matches starting after this — intros sit at the head of the
   *  episode (cold open at most 4–5min), later matches are mid-show recurrences or outros. */
  private static readonly MAX_PLAUSIBLE_INTRO_START = 300; // 5 min
  /** Cluster bucket size (seconds) — matches within this distance from each other
   *  are considered the same intro candidate when voting across pairs. */
  private static readonly CLUSTER_BUCKET_SECONDS = 15;
  /** Chromaprint fixed resolution — 1 hash every ~0.124s (8.077 Hz). Matches
   *  the internal frame shift used by fpcalc regardless of file duration. */
  private static readonly SECONDS_PER_SAMPLE = 0.1238;

  constructor(
    @InjectRepository(EpisodeMarker)
    private readonly markerRepo: Repository<EpisodeMarker>,
    @InjectRepository(Episode)
    private readonly episodeRepo: Repository<Episode>,
    @InjectRepository(MediaFile)
    private readonly mediaFileRepo: Repository<MediaFile>,
    @InjectRepository(Season)
    private readonly seasonRepo: Repository<Season>,
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Fingerprint + match every episode of a season. Returns the number of
   * intros newly created/updated. Skips episodes whose marker is `manual=true`.
   */
  async detectSeasonIntros(
    seasonId: number,
    onProgress?: (current: number, total: number, message: string) => void,
  ): Promise<{ introsDetected: number; skipped: number }> {
    const t0 = Date.now();
    const season = await this.seasonRepo.findOne({ where: { id: seasonId } });
    if (!season) throw new Error(`Season #${seasonId} not found`);

    const media = await this.mediaRepo.findOne({
      where: { id: season.mediaId },
    });
    if (!media?.path) {
      this.log.warn(`Skip season #${seasonId}: parent media has no path`);
      return { introsDetected: 0, skipped: 0 };
    }
    const mediaPath: string = media.path;

    const episodes = await this.episodeRepo.find({
      where: { season: { id: seasonId }, hasFile: true },
      order: { episodeNumber: 'ASC' },
    });
    this.log.log(
      `▶ Intro detection START — "${media.title}" S${String(season.seasonNumber).padStart(2, '0')} (season #${seasonId}): ${episodes.length} episode(s) with file`,
    );
    if (episodes.length < 2) {
      this.log.log(
        `Season #${seasonId}: only ${episodes.length} episode(s) with files — need ≥ 2, skipping detection`,
      );
      return { introsDetected: 0, skipped: episodes.length };
    }

    // Resolve absolute paths via media_files (one file per episode — pick latest).
    const files = await this.mediaFileRepo.find({
      where: { episode: { id: In(episodes.map((e) => e.id)) } },
      order: { id: 'DESC' },
    });
    const fileByEpisode = new Map<number, MediaFile>();
    for (const f of files) {
      if (!fileByEpisode.has(f.episodeId)) fileByEpisode.set(f.episodeId, f);
    }

    const lookupMin =
      Number(await this.settings.get('introMaxLookupMinutes')) ||
      IntroDetectionService.DEFAULT_MAX_LOOKUP_MINUTES;
    const lookupSec = lookupMin * 60;
    const minSegmentSec =
      Number(await this.settings.get('introMinSegmentSeconds')) ||
      IntroDetectionService.DEFAULT_MIN_SEGMENT_SECONDS;
    this.log.log(
      `Season #${seasonId}: scanning first ${lookupMin} min of audio per episode, min segment ${minSegmentSec}s`,
    );

    // Existing manual markers — never overwrite.
    const existingManual = await this.markerRepo.find({
      where: {
        episode: { id: In(episodes.map((e) => e.id)) },
        type: 'intro',
        manual: true,
      },
    });
    const manualIds = new Set(existingManual.map((m) => m.episodeId));

    // ── Shortcut: use embedded chapter markers when available ──
    // Many releases (especially Netflix originals, Blu-ray rips) ship with
    // named chapters like "Main Titles" / "Opening Credits" / "Intro". When
    // present they are precise — skip fingerprinting for those episodes.
    const needsFingerprint: typeof episodes = [];
    const chapterStarts: number[] = [];
    const chapterLengths: number[] = [];
    /** First chapter-based peer — used as a reference template when other
     *  episodes lack chapter metadata (reference-based search bypasses
     *  pairwise all-to-all and tolerates variable cold-open offsets). */
    let referencePeer: {
      episode: Episode;
      startSec: number;
      endSec: number;
    } | null = null;
    let chapterHits = 0;
    for (const ep of episodes) {
      if (manualIds.has(ep.id)) continue;
      const file = fileByEpisode.get(ep.id);
      const fromChapter = extractIntroFromChapters(file?.streamInfo?.chapters);
      if (fromChapter) {
        await this.markerRepo.delete({
          episode: { id: ep.id },
          type: 'intro',
          manual: false,
        });
        await this.markerRepo.save({
          episode: { id: ep.id },
          type: 'intro',
          startSeconds: fromChapter.startSeconds,
          endSeconds: fromChapter.endSeconds,
          confidence: 1,
          manual: false,
        } as Partial<EpisodeMarker>);
        chapterHits++;
        chapterStarts.push(fromChapter.startSeconds);
        chapterLengths.push(fromChapter.endSeconds - fromChapter.startSeconds);
        if (!referencePeer) {
          referencePeer = {
            episode: ep,
            startSec: fromChapter.startSeconds,
            endSec: fromChapter.endSeconds,
          };
        }
        this.log.log(
          `  E${ep.episodeNumber}: intro from chapter "${fromChapter.title}" ${this.fmtTime(fromChapter.startSeconds)}–${this.fmtTime(fromChapter.endSeconds)}`,
        );
      } else {
        needsFingerprint.push(ep);
      }
    }
    // Reference window built from peer episodes of the same season that had
    // chapter-derived intros. Intros often sit at wildly different positions
    // across episodes (cold opens of variable length) so we use the observed
    // [min, max] range + a small margin instead of a tight ± tolerance.
    const REF_MARGIN_SECONDS = 30;
    const referenceMin =
      chapterStarts.length >= 2
        ? Math.max(0, Math.min(...chapterStarts) - REF_MARGIN_SECONDS)
        : null;
    const referenceMax =
      chapterStarts.length >= 2
        ? Math.max(...chapterStarts) + REF_MARGIN_SECONDS
        : null;
    const referenceLength =
      chapterLengths.length >= 2 ? median(chapterLengths) : null;
    if (referenceMin != null && referenceMax != null) {
      this.log.log(
        `Season #${seasonId}: reference window from ${chapterStarts.length} chapter(s) — intros between ${this.fmtTime(referenceMin)} and ${this.fmtTime(referenceMax)}, median length ${referenceLength?.toFixed(0) ?? '?'}s`,
      );
    }
    if (chapterHits) {
      this.log.log(
        `Season #${seasonId}: ${chapterHits}/${episodes.length} intros resolved from embedded chapters`,
      );
    }
    if (needsFingerprint.length < 2) {
      this.log.log(
        `Season #${seasonId}: ${needsFingerprint.length} episode(s) left to fingerprint — skipping pairwise match`,
      );
      return { introsDetected: chapterHits, skipped: 0 };
    }

    // Fingerprint every remaining episode (+ the reference peer so we can
    // use its intro audio as a template search pattern).
    const fingerprints = new Map<number, Fingerprint>();
    const concurrency = 4;
    let processed = 0;
    const toFingerprint = referencePeer
      ? [...needsFingerprint, referencePeer.episode]
      : needsFingerprint;
    onProgress?.(
      0,
      toFingerprint.length,
      `Fingerprinting 0/${toFingerprint.length}`,
    );
    for (let i = 0; i < toFingerprint.length; i += concurrency) {
      const slice = toFingerprint.slice(i, i + concurrency);
      await Promise.all(
        slice.map(async (ep) => {
          const file = fileByEpisode.get(ep.id);
          if (!file) {
            this.log.warn(
              `Episode #${ep.id} (E${ep.episodeNumber}): no media file found, skipping`,
            );
            return;
          }
          const abs = path.resolve(mediaPath, file.relativePath);
          const epT0 = Date.now();
          try {
            const fp = await this.fingerprint(abs, lookupSec);
            fingerprints.set(ep.id, fp);
            this.log.log(
              `  ✓ E${ep.episodeNumber} fingerprinted in ${((Date.now() - epT0) / 1000).toFixed(1)}s (${fp.hashes.length} hashes, ${fp.durationSeconds.toFixed(1)}s audio)`,
            );
          } catch (err) {
            this.log.warn(
              `  ✗ E${ep.episodeNumber} fpcalc failed (${abs}): ${(err as Error).message}`,
            );
          }
          processed++;
          onProgress?.(
            processed,
            toFingerprint.length,
            `Fingerprinting ${processed}/${toFingerprint.length}`,
          );
        }),
      );
    }

    // ── Reference-based search ──
    // For each chapter-less episode, look for the reference peer's intro
    // audio at any offset in the first 6 min. Handles cases where pairwise
    // between chapter-less episodes fails (e.g. when their rip sources differ
    // enough that chromaprint can't align their common intro).
    const resolvedByReference = new Set<number>();
    if (referencePeer) {
      const peerFp = fingerprints.get(referencePeer.episode.id);
      if (peerFp) {
        const refStart = Math.min(
          peerFp.hashes.length,
          this.secondsToSamples(referencePeer.startSec),
        );
        const refEnd = Math.min(
          peerFp.hashes.length,
          this.secondsToSamples(referencePeer.endSec),
        );
        const refHashes = peerFp.hashes.slice(refStart, refEnd);
        this.log.log(
          `Season #${seasonId}: reference template = E${referencePeer.episode.episodeNumber} ${this.fmtTime(referencePeer.startSec)}–${this.fmtTime(referencePeer.endSec)} (${refHashes.length} hashes)`,
        );
        const maxSearchSec = IntroDetectionService.MAX_PLAUSIBLE_INTRO_START;
        for (const ep of needsFingerprint) {
          const targetFp = fingerprints.get(ep.id);
          if (!targetFp) continue;
          const m = this.findByReference(refHashes, targetFp, maxSearchSec);
          if (!m) {
            this.log.log(
              `  E${ep.episodeNumber}: reference search found no good alignment`,
            );
            continue;
          }
          await this.markerRepo.delete({
            episode: { id: ep.id },
            type: 'intro',
            manual: false,
          });
          await this.markerRepo.save({
            episode: { id: ep.id },
            type: 'intro',
            startSeconds: m.startSeconds,
            endSeconds: m.endSeconds,
            confidence: m.conf,
            manual: false,
          } as Partial<EpisodeMarker>);
          resolvedByReference.add(ep.id);
          chapterHits++; // counts toward "detected" stat
          this.log.log(
            `  E${ep.episodeNumber}: intro from reference ${this.fmtTime(m.startSeconds)}–${this.fmtTime(m.endSeconds)} (${(m.endSeconds - m.startSeconds).toFixed(1)}s, conf=${m.conf.toFixed(2)})`,
          );
        }
      }
    }

    if (fingerprints.size < 2) {
      this.log.warn(
        `Season #${seasonId}: only ${fingerprints.size} fingerprint(s) usable, skipping match`,
      );
      return {
        introsDetected: chapterHits,
        skipped: needsFingerprint.length,
      };
    }
    this.log.log(
      `Season #${seasonId}: ${fingerprints.size}/${needsFingerprint.length} fingerprints OK, matching pairwise…`,
    );

    // For each episode, gather ALL plausible matches against every peer (not
    // just the longest — leading production logos systematically beat the
    // real intro on raw length). Cluster all candidates by start time, prefer
    // the cluster sitting AFTER the typical leading-logo zone (start > 5s)
    // when one exists, fall back to the start=0 cluster otherwise.
    let detected = chapterHits;
    const ids = [...fingerprints.keys()];
    /** Matches starting before this are treated as "leading-logo zone" and
     *  only used when no later cluster has consensus. */
    const LEADING_LOGO_GUARD = 5; // seconds
    for (let i = 0; i < ids.length; i++) {
      const aId = ids[i];
      if (manualIds.has(aId)) continue;
      if (resolvedByReference.has(aId)) continue;
      // Reference peer itself — not a target.
      if (referencePeer && aId === referencePeer.episode.id) continue;
      const a = fingerprints.get(aId)!;
      const matches: { start: number; length: number; conf: number }[] = [];
      for (let j = 0; j < ids.length; j++) {
        if (i === j) continue;
        const b = fingerprints.get(ids[j])!;
        const all = this.findAllMatches(a.hashes, b.hashes, minSegmentSec, a);
        for (const m of all) {
          const start = this.samplesToSeconds(m.aStart);
          const length = this.samplesToSeconds(m.length);
          if (length > IntroDetectionService.MAX_PLAUSIBLE_INTRO_SECONDS)
            continue;
          if (start > IntroDetectionService.MAX_PLAUSIBLE_INTRO_START) continue;
          matches.push({
            start,
            length,
            conf:
              1 - m.hammingAvg / IntroDetectionService.HAMMING_THRESHOLD / 4,
          });
        }
      }
      if (matches.length === 0) {
        this.log.log(
          `  E#${aId}: no plausible match (all rejected by length/position filters)`,
        );
        continue;
      }

      // Cluster by start (bucket = CLUSTER_BUCKET_SECONDS).
      const bucket = IntroDetectionService.CLUSTER_BUCKET_SECONDS;
      const clusters = new Map<number, typeof matches>();
      for (const m of matches) {
        const key = Math.round(m.start / bucket) * bucket;
        const arr = clusters.get(key) ?? [];
        arr.push(m);
        clusters.set(key, arr);
      }

      // Three-tier selection:
      //   1. If a peer reference range exists, pick the biggest cluster that
      //      falls within it (covers variable cold-open lengths across a
      //      season while still excluding logos at start=0).
      //   2. Else: largest cluster outside the leading logo zone.
      //   3. Fallback: largest cluster overall (may be the logo).
      let bestCluster: typeof matches = [];
      let bestKey = 0;
      let pickFromReference = false;
      if (referenceMin != null && referenceMax != null) {
        for (const [key, arr] of clusters) {
          if (key < referenceMin || key > referenceMax) continue;
          if (arr.length > bestCluster.length) {
            bestCluster = arr;
            bestKey = key;
          }
        }
        if (bestCluster.length >= 2) {
          pickFromReference = true;
          this.log.debug(
            `  E#${aId}: reference-guided pick (bucket ${bestKey}s, range ${referenceMin.toFixed(0)}–${referenceMax.toFixed(0)}s)`,
          );
        }
      }
      if (bestCluster.length < 2) {
        for (const [key, arr] of clusters) {
          if (key < LEADING_LOGO_GUARD) continue;
          if (arr.length > bestCluster.length) {
            bestCluster = arr;
            bestKey = key;
          }
        }
      }
      if (bestCluster.length < 2) {
        for (const [key, arr] of clusters) {
          if (arr.length > bestCluster.length) {
            bestCluster = arr;
            bestKey = key;
          }
        }
      }
      if (bestCluster.length < 2) {
        this.log.log(
          `  E#${aId}: no consensus cluster (best had ${bestCluster.length} vote out of ${matches.length} candidates)`,
        );
        continue;
      }
      this.log.debug(
        `  E#${aId}: ${clusters.size} candidate cluster(s), picked bucket ${bestKey}s with ${bestCluster.length} vote(s)`,
      );

      const start = median(bestCluster.map((m) => m.start));
      let length = median(bestCluster.map((m) => m.length));
      const conf = median(bestCluster.map((m) => m.conf));
      // When the pick comes from the reference-range tier and the detected
      // length is noticeably shorter than the peer median, stretch it to the
      // peer consensus — typical case: fingerprint matched only the most
      // stable 15–20s of a 60s intro.
      if (
        pickFromReference &&
        referenceLength != null &&
        length < referenceLength * 0.7
      ) {
        length = referenceLength;
      }
      const startSeconds = Math.max(0, start);
      const endSeconds = Math.min(lookupSec, start + length);
      if (endSeconds - startSeconds < minSegmentSec) continue;

      // Upsert (delete + insert because partial unique index handling).
      await this.markerRepo.delete({
        episode: { id: aId },
        type: 'intro',
        manual: false,
      });
      await this.markerRepo.save({
        episode: { id: aId },
        type: 'intro',
        startSeconds,
        endSeconds,
        confidence: clamp(conf, 0, 1),
        manual: false,
      } as Partial<EpisodeMarker>);
      detected++;
      this.log.log(
        `  E#${aId}: intro ${this.fmtTime(startSeconds)}–${this.fmtTime(endSeconds)} (${(endSeconds - startSeconds).toFixed(1)}s, conf=${conf.toFixed(2)}, ${bestCluster.length}/${matches.length} peers agreed)`,
      );
    }

    onProgress?.(
      needsFingerprint.length,
      needsFingerprint.length,
      `Detection complete: ${detected} intro(s)`,
    );
    this.log.log(
      `■ Intro detection END — "${media.title}" S${String(season.seasonNumber).padStart(2, '0')} (season #${seasonId}): ${detected} intro(s) saved in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
    return { introsDetected: detected, skipped: 0 };
  }

  /**
   * Detect end-credits / outro markers for a season. Mirrors the intro
   * pipeline: chapter shortcut → reference-template search using a chapter
   * peer → pairwise chromaprint fallback. Scans only the last `lookupSec`
   * seconds of each episode via ffmpeg-seek → fpcalc pipeline.
   */
  async detectSeasonOutros(
    seasonId: number,
    onProgress?: (current: number, total: number, message: string) => void,
  ): Promise<{ outrosDetected: number; skipped: number }> {
    const t0 = Date.now();
    const season = await this.seasonRepo.findOne({ where: { id: seasonId } });
    if (!season) throw new Error(`Season #${seasonId} not found`);
    const media = await this.mediaRepo.findOne({
      where: { id: season.mediaId },
    });
    if (!media?.path) return { outrosDetected: 0, skipped: 0 };
    const mediaPath: string = media.path;

    const episodes = await this.episodeRepo.find({
      where: { season: { id: seasonId }, hasFile: true },
      order: { episodeNumber: 'ASC' },
    });
    if (!episodes.length) return { outrosDetected: 0, skipped: 0 };

    this.log.log(
      `▶ Outro detection START — "${media.title}" S${String(season.seasonNumber).padStart(2, '0')} (season #${seasonId}): ${episodes.length} episode(s)`,
    );

    const files = await this.mediaFileRepo.find({
      where: { episode: { id: In(episodes.map((e) => e.id)) } },
      order: { id: 'DESC' },
    });
    const fileByEpisode = new Map<number, MediaFile>();
    for (const f of files) {
      if (!fileByEpisode.has(f.episodeId)) fileByEpisode.set(f.episodeId, f);
    }

    const lookupMin =
      Number(await this.settings.get('introMaxLookupMinutes')) ||
      IntroDetectionService.DEFAULT_MAX_LOOKUP_MINUTES;
    const lookupSec = lookupMin * 60;
    const minSegmentSec =
      Number(await this.settings.get('introMinSegmentSeconds')) ||
      IntroDetectionService.DEFAULT_MIN_SEGMENT_SECONDS;

    // Never overwrite manual markers.
    const existingManual = await this.markerRepo.find({
      where: {
        episode: { id: In(episodes.map((e) => e.id)) },
        type: 'outro',
        manual: true,
      },
    });
    const manualIds = new Set(existingManual.map((m) => m.episodeId));

    // ── Chapter shortcut ──
    const needsFingerprint: typeof episodes = [];
    let referencePeer: {
      episode: Episode;
      startSec: number;
      endSec: number;
    } | null = null;
    let detected = 0;
    for (const ep of episodes) {
      if (manualIds.has(ep.id)) continue;
      const file = fileByEpisode.get(ep.id);
      const dur = file?.streamInfo?.durationSeconds ?? 0;
      const fromChapter = extractOutroFromChapters(
        file?.streamInfo?.chapters,
        dur,
      );
      if (fromChapter) {
        await this.markerRepo.delete({
          episode: { id: ep.id },
          type: 'outro',
          manual: false,
        });
        await this.markerRepo.save({
          episode: { id: ep.id },
          type: 'outro',
          startSeconds: fromChapter.startSeconds,
          endSeconds: fromChapter.endSeconds,
          confidence: 1,
          manual: false,
        } as Partial<EpisodeMarker>);
        detected++;
        if (!referencePeer) {
          referencePeer = {
            episode: ep,
            startSec: fromChapter.startSeconds,
            endSec: fromChapter.endSeconds,
          };
        }
        this.log.log(
          `  E${ep.episodeNumber}: outro from chapter "${fromChapter.title}" ${this.fmtTime(fromChapter.startSeconds)}–${this.fmtTime(fromChapter.endSeconds)}`,
        );
      } else {
        needsFingerprint.push(ep);
      }
    }

    if (needsFingerprint.length === 0) {
      this.log.log(
        `■ Outro detection END — "${media.title}" S${String(season.seasonNumber).padStart(2, '0')}: ${detected} outro(s) via chapters (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
      );
      return { outrosDetected: detected, skipped: 0 };
    }
    if (needsFingerprint.length < 2 && !referencePeer) {
      this.log.log(
        `Season #${seasonId}: ${needsFingerprint.length} chapter-less episode(s), no reference peer — skipping fingerprint fallback`,
      );
      return { outrosDetected: detected, skipped: needsFingerprint.length };
    }

    // ── Fingerprint END of each chapter-less episode (+ reference peer) ──
    const fingerprints = new Map<number, Fingerprint>();
    const toFingerprint = referencePeer
      ? [...needsFingerprint, referencePeer.episode]
      : needsFingerprint;
    const concurrency = 4;
    let processed = 0;
    onProgress?.(
      0,
      toFingerprint.length,
      `Outro fingerprinting 0/${toFingerprint.length}`,
    );
    for (let i = 0; i < toFingerprint.length; i += concurrency) {
      const slice = toFingerprint.slice(i, i + concurrency);
      await Promise.all(
        slice.map(async (ep) => {
          const file = fileByEpisode.get(ep.id);
          const dur = file?.streamInfo?.durationSeconds ?? 0;
          if (!file || !dur) {
            this.log.warn(
              `  E${ep.episodeNumber}: no duration known, skipping outro fingerprint`,
            );
            return;
          }
          const abs = path.resolve(mediaPath, file.relativePath);
          const startSec = Math.max(0, dur - lookupSec);
          const epT0 = Date.now();
          try {
            const fp = await this.fingerprintWindow(abs, startSec, lookupSec);
            fingerprints.set(ep.id, fp);
            this.log.log(
              `  ✓ E${ep.episodeNumber} outro fingerprint in ${((Date.now() - epT0) / 1000).toFixed(1)}s (${fp.hashes.length} hashes, offset ${this.fmtTime(startSec)})`,
            );
          } catch (err) {
            this.log.warn(
              `  ✗ E${ep.episodeNumber} outro fingerprint failed: ${(err as Error).message}`,
            );
          }
          processed++;
          onProgress?.(
            processed,
            toFingerprint.length,
            `Outro fingerprinting ${processed}/${toFingerprint.length}`,
          );
        }),
      );
    }

    // ── Reference-based search (peer chapter outro as template) ──
    const resolvedByReference = new Set<number>();
    if (referencePeer) {
      const peerFp = fingerprints.get(referencePeer.episode.id);
      if (peerFp) {
        // Chapter position is absolute in the file; convert to index inside
        // the fingerprint window (subtract baseOffset).
        const relStart = Math.max(
          0,
          this.secondsToSamples(referencePeer.startSec - peerFp.baseOffsetSec),
        );
        const relEnd = Math.min(
          peerFp.hashes.length,
          this.secondsToSamples(referencePeer.endSec - peerFp.baseOffsetSec),
        );
        const refHashes = peerFp.hashes.slice(relStart, relEnd);
        this.log.log(
          `Season #${seasonId}: outro reference = E${referencePeer.episode.episodeNumber} ${this.fmtTime(referencePeer.startSec)}–${this.fmtTime(referencePeer.endSec)} (${refHashes.length} hashes)`,
        );
        for (const ep of needsFingerprint) {
          const targetFp = fingerprints.get(ep.id);
          if (!targetFp) continue;
          const m = this.findByReference(refHashes, targetFp, lookupSec);
          if (!m) {
            this.log.log(
              `  E${ep.episodeNumber}: outro reference search found no alignment`,
            );
            continue;
          }
          const absStart = targetFp.baseOffsetSec + m.startSeconds;
          const absEnd = targetFp.baseOffsetSec + m.endSeconds;
          await this.markerRepo.delete({
            episode: { id: ep.id },
            type: 'outro',
            manual: false,
          });
          await this.markerRepo.save({
            episode: { id: ep.id },
            type: 'outro',
            startSeconds: absStart,
            endSeconds: absEnd,
            confidence: m.conf,
            manual: false,
          } as Partial<EpisodeMarker>);
          resolvedByReference.add(ep.id);
          detected++;
          this.log.log(
            `  E${ep.episodeNumber}: outro from reference ${this.fmtTime(absStart)}–${this.fmtTime(absEnd)} (${(absEnd - absStart).toFixed(1)}s, conf=${m.conf.toFixed(2)})`,
          );
        }
      }
    }

    // ── Pairwise fallback across remaining chapter-less episodes ──
    const ids = [...fingerprints.keys()].filter(
      (id) =>
        !resolvedByReference.has(id) &&
        id !== referencePeer?.episode.id &&
        !manualIds.has(id),
    );
    if (ids.length >= 2) {
      const bucket = IntroDetectionService.CLUSTER_BUCKET_SECONDS;
      for (let i = 0; i < ids.length; i++) {
        const aId = ids[i];
        const a = fingerprints.get(aId)!;
        const matches: { start: number; length: number; conf: number }[] = [];
        for (let j = 0; j < ids.length; j++) {
          if (i === j) continue;
          const b = fingerprints.get(ids[j])!;
          const all = this.findAllMatches(a.hashes, b.hashes, minSegmentSec, a);
          for (const m of all) {
            const start = this.samplesToSeconds(m.aStart);
            const length = this.samplesToSeconds(m.length);
            if (length > IntroDetectionService.MAX_PLAUSIBLE_INTRO_SECONDS)
              continue;
            matches.push({
              start,
              length,
              conf:
                1 - m.hammingAvg / IntroDetectionService.HAMMING_THRESHOLD / 4,
            });
          }
        }
        if (matches.length === 0) continue;

        const clusters = new Map<number, typeof matches>();
        for (const m of matches) {
          const key = Math.round(m.start / bucket) * bucket;
          const arr = clusters.get(key) ?? [];
          arr.push(m);
          clusters.set(key, arr);
        }
        let bestCluster: typeof matches = [];
        for (const arr of clusters.values()) {
          if (arr.length > bestCluster.length) bestCluster = arr;
        }
        if (bestCluster.length < 2) continue;

        const relStart = median(bestCluster.map((m) => m.start));
        const relLen = median(bestCluster.map((m) => m.length));
        const conf = median(bestCluster.map((m) => m.conf));
        const absStart = a.baseOffsetSec + Math.max(0, relStart);
        const absEnd = a.baseOffsetSec + relStart + relLen;

        await this.markerRepo.delete({
          episode: { id: aId },
          type: 'outro',
          manual: false,
        });
        await this.markerRepo.save({
          episode: { id: aId },
          type: 'outro',
          startSeconds: absStart,
          endSeconds: absEnd,
          confidence: clamp(conf, 0, 1),
          manual: false,
        } as Partial<EpisodeMarker>);
        detected++;
        this.log.log(
          `  E#${aId}: outro pairwise ${this.fmtTime(absStart)}–${this.fmtTime(absEnd)} (${(absEnd - absStart).toFixed(1)}s, conf=${conf.toFixed(2)}, ${bestCluster.length} peers)`,
        );
      }
    }

    const skipped = needsFingerprint.filter(
      (ep) => !resolvedByReference.has(ep.id) && !ids.includes(ep.id),
    ).length;
    this.log.log(
      `■ Outro detection END — "${media.title}" S${String(season.seasonNumber).padStart(2, '0')}: ${detected} outro(s) saved, ${skipped} without result (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
    );
    return { outrosDetected: detected, skipped };
  }

  /**
   * Run `fpcalc -raw -length <s> <path>` and parse out the int32 fingerprint.
   * fpcalc uses libavcodec internally and accepts video containers directly.
   */
  private async fingerprint(
    absPath: string,
    maxSeconds: number,
  ): Promise<Fingerprint> {
    const { stdout } = await execFileAsync(
      'fpcalc',
      ['-raw', '-length', String(maxSeconds), absPath],
      { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
    );
    const durMatch = stdout.match(/DURATION=([\d.]+)/);
    const fpMatch = stdout.match(/FINGERPRINT=([\d,\-]+)/);
    if (!fpMatch) throw new Error('fpcalc returned no FINGERPRINT line');
    const hashes = fpMatch[1].split(',').map((s) => parseInt(s, 10) | 0);
    return {
      hashes,
      durationSeconds: durMatch ? parseFloat(durMatch[1]) : maxSeconds,
      baseOffsetSec: 0,
    };
  }

  /**
   * Fingerprint a specific [startSec, startSec+lengthSec] window of the file
   * by piping ffmpeg audio output into fpcalc stdin. fpcalc 1.5.1 doesn't
   * expose a `-start` flag, so we use ffmpeg's `-ss` seek.
   */
  private fingerprintWindow(
    absPath: string,
    startSec: number,
    lengthSec: number,
  ): Promise<Fingerprint> {
    return new Promise((resolve, reject) => {
      const ffmpegArgs = [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        String(Math.max(0, Math.floor(startSec))),
        '-i',
        absPath,
        '-t',
        String(lengthSec),
        '-vn',
        '-ac',
        '1',
        '-ar',
        '22050',
        '-f',
        'wav',
        '-',
      ];
      // Low I/O + CPU priority for background detection
      const ffmpeg = process.platform === 'linux'
        ? spawn('ionice', ['-c3', 'nice', '-n19', 'ffmpeg', ...ffmpegArgs])
        : spawn('ffmpeg', ffmpegArgs);
      const fpcalc = spawn(
        'fpcalc',
        ['-raw', '-length', String(lengthSec), '-'],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );

      let stdout = '';
      let fpcalcErr = '';
      let ffmpegErr = '';
      fpcalc.stdout.on('data', (d) => (stdout += d.toString()));
      fpcalc.stderr.on('data', (d) => (fpcalcErr += d.toString()));
      ffmpeg.stderr?.on('data', (d) => (ffmpegErr += d.toString()));
      ffmpeg.stdout!.pipe(fpcalc.stdin);
      ffmpeg.on('error', reject);
      fpcalc.on('error', reject);

      const timeout = setTimeout(() => {
        ffmpeg.kill('SIGKILL');
        fpcalc.kill('SIGKILL');
        reject(new Error('fingerprintWindow timed out'));
      }, 180_000);

      fpcalc.on('close', (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          return reject(
            new Error(
              `fpcalc exited ${code}: ${fpcalcErr.trim() || ffmpegErr.trim()}`,
            ),
          );
        }
        const fpMatch = stdout.match(/FINGERPRINT=([\d,\-]+)/);
        if (!fpMatch) {
          return reject(new Error('fpcalc returned no FINGERPRINT line'));
        }
        const durMatch = stdout.match(/DURATION=([\d.]+)/);
        const hashes = fpMatch[1].split(',').map((s) => parseInt(s, 10) | 0);
        resolve({
          hashes,
          durationSeconds: durMatch ? parseFloat(durMatch[1]) : lengthSec,
          baseOffsetSec: startSec,
        });
      });
    });
  }

  /**
   * Slide one fingerprint against the other across [-MAX_LAG, +MAX_LAG] and
   * return ALL contiguous runs of low-Hamming-distance hashes that meet
   * `minSegmentSeconds`. Multiple matches per pair lets the caller cluster
   * across pairs and reject leading-logo matches that win on length but lose
   * to the consensus intro window.
   */
  private findAllMatches(
    a: number[],
    b: number[],
    minSegmentSeconds: number,
    _aMeta: Fingerprint,
  ): MatchResult[] {
    const minLen = Math.max(8, this.secondsToSamples(minSegmentSeconds));
    const out: MatchResult[] = [];
    const push = (start: number, len: number, ham: number, lag: number) => {
      if (len >= minLen) {
        out.push({
          aStart: start,
          bStart: start + lag,
          length: len,
          hammingAvg: ham / len,
        });
      }
    };
    for (
      let lag = -IntroDetectionService.MAX_LAG_SAMPLES;
      lag <= IntroDetectionService.MAX_LAG_SAMPLES;
      lag++
    ) {
      const aStart = Math.max(0, -lag);
      const aEnd = Math.min(a.length, b.length - lag);
      let runStart = -1;
      let runLen = 0;
      let runHam = 0;
      for (let i = aStart; i < aEnd; i++) {
        const ham = popcount32(a[i] ^ b[i + lag]);
        if (ham <= IntroDetectionService.HAMMING_THRESHOLD) {
          if (runStart < 0) {
            runStart = i;
            runLen = 0;
            runHam = 0;
          }
          runLen++;
          runHam += ham;
        } else {
          push(runStart, runLen, runHam, lag);
          runStart = -1;
          runLen = 0;
          runHam = 0;
        }
      }
      push(runStart, runLen, runHam, lag);
    }
    return out;
  }

  private samplesToSeconds(samples: number): number {
    // Chromaprint emits hashes at a fixed rate regardless of `-length` or
    // file duration. Do NOT use fp.durationSeconds (= full file length from
    // libavformat, not the fingerprinted window).
    return samples * IntroDetectionService.SECONDS_PER_SAMPLE;
  }

  private secondsToSamples(seconds: number): number {
    return Math.round(seconds / IntroDetectionService.SECONDS_PER_SAMPLE);
  }

  /**
   * Slide a reference hash pattern (extracted from a peer's intro window)
   * across the target fingerprint and return the best alignment position.
   * Works across arbitrary time offsets — the reference doesn't care where
   * peer A's intro was, only what it sounds like. Requires ≥ 30% of the
   * reference hashes to match at the best offset to accept a result.
   */
  private findByReference(
    refHashes: number[],
    target: Fingerprint,
    maxStartSeconds: number,
  ): { startSeconds: number; endSeconds: number; conf: number } | null {
    if (refHashes.length < 8) return null;
    const maxStartIdx = Math.min(
      target.hashes.length - refHashes.length,
      this.secondsToSamples(maxStartSeconds),
    );
    if (maxStartIdx < 0) return null;
    let bestOffset = -1;
    let bestMatches = 0;
    for (let off = 0; off <= maxStartIdx; off++) {
      let matches = 0;
      for (let i = 0; i < refHashes.length; i++) {
        if (
          popcount32(refHashes[i] ^ target.hashes[off + i]) <=
          IntroDetectionService.HAMMING_THRESHOLD
        ) {
          matches++;
        }
      }
      if (matches > bestMatches) {
        bestMatches = matches;
        bestOffset = off;
      }
    }
    if (bestOffset < 0) return null;
    const conf = bestMatches / refHashes.length;
    if (conf < 0.3) return null;
    const startSeconds = this.samplesToSeconds(bestOffset);
    const endSeconds = this.samplesToSeconds(bestOffset + refHashes.length);
    return { startSeconds, endSeconds, conf };
  }

  private fmtTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** 32-bit popcount (count of set bits). */
function popcount32(n: number): number {
  n = n | 0;
  n = n - ((n >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function median(arr: number[]): number {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * Look for an intro-labeled chapter in the container metadata.
 * Matches common titles used by Netflix, Blu-ray authoring tools, etc.
 * Returns null if no chapter looks like an intro.
 */
const INTRO_CHAPTER_REGEX =
  /\b(intro|opening|opening credits|main title|main titles|theme|titles?)\b/i;
function extractIntroFromChapters(
  chapters:
    | { startSeconds: number; endSeconds: number; title?: string }[]
    | undefined,
): { startSeconds: number; endSeconds: number; title: string } | null {
  if (!chapters?.length) return null;
  for (const c of chapters) {
    if (!c.title) continue;
    if (!INTRO_CHAPTER_REGEX.test(c.title)) continue;
    if (c.endSeconds <= c.startSeconds) continue;
    const len = c.endSeconds - c.startSeconds;
    // Sanity: intros are 10–180s, anywhere in the first 6 minutes.
    if (len < 10 || len > 180) continue;
    if (c.startSeconds > 360) continue;
    return {
      startSeconds: c.startSeconds,
      endSeconds: c.endSeconds,
      title: c.title,
    };
  }
  return null;
}

/**
 * Look for an outro/credits-labeled chapter. Typically appears at the very
 * end of the episode — "End Credits", "Credits", "Outro", "Ending", etc.
 * Returns null if no chapter looks like an outro.
 */
const OUTRO_CHAPTER_REGEX =
  /\b(outro|ending|end.?credits?|credits?|closing)\b/i;
function extractOutroFromChapters(
  chapters:
    | { startSeconds: number; endSeconds: number; title?: string }[]
    | undefined,
  fileDurationSec: number,
): { startSeconds: number; endSeconds: number; title: string } | null {
  if (!chapters?.length) return null;
  // Prefer the LAST matching chapter (some files have both "Opening Credits"
  // and "End Credits" — we only want the tail one).
  for (let i = chapters.length - 1; i >= 0; i--) {
    const c = chapters[i];
    if (!c.title) continue;
    if (!OUTRO_CHAPTER_REGEX.test(c.title)) continue;
    if (c.endSeconds <= c.startSeconds) continue;
    const len = c.endSeconds - c.startSeconds;
    if (len < 10 || len > 300) continue;
    // Outros sit in the last quarter of the file — skip matches near the head
    // (e.g. the INTRO_CHAPTER_REGEX could overlap on "Opening Credits", but
    // we want only the tail one).
    if (fileDurationSec > 0 && c.startSeconds < fileDurationSec * 0.6) continue;
    return {
      startSeconds: c.startSeconds,
      endSeconds: c.endSeconds,
      title: c.title,
    };
  }
  return null;
}
