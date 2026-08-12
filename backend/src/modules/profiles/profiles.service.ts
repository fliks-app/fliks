import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { QualityProfile } from './entities/quality-profile.entity';
import { LanguageProfile } from './entities/language-profile.entity';
import { CreateQualityProfileDto } from './dto/create-quality-profile.dto';
import { CreateLanguageProfileDto } from './dto/create-language-profile.dto';
import { buildDefaultMovieQualityProfileDto } from './default-movie-quality-profile';
import { buildDefaultLanguageProfileDto } from './default-language-profile';
import {
  buildAllowedQualityIds,
  allowedAudioLanguageIds,
} from '../../common/release-scoring';

@Injectable()
export class ProfilesService {
  constructor(
    @InjectRepository(QualityProfile)
    private readonly qpRepo: Repository<QualityProfile>,
    @InjectRepository(LanguageProfile)
    private readonly lpRepo: Repository<LanguageProfile>,
  ) {}

  async ensureDefaultQualityProfiles(): Promise<void> {
    if ((await this.qpRepo.count()) > 0) return;
    await this.createQualityProfile(buildDefaultMovieQualityProfileDto());
  }

  async ensureDefaultLanguageProfiles(): Promise<void> {
    if ((await this.lpRepo.count()) > 0) return;
    await this.createLanguageProfile(buildDefaultLanguageProfileDto());
  }

  async resolveQualityProfileIdForImport(
    requested?: number,
  ): Promise<number | null> {
    await this.ensureDefaultQualityProfiles();
    if (requested != null) {
      const p = await this.qpRepo.findOne({ where: { id: requested } });
      if (!p) {
        throw new BadRequestException(
          `Quality profile #${requested} not found`,
        );
      }
      return p.id;
    }
    const [first] = await this.qpRepo.find({
      order: { id: 'ASC' },
      take: 1,
    });
    return first?.id ?? null;
  }

  /**
   * Effective allowed-quality + allowed-audio-language sets for a media.
   * No runtime fallback to system-default profiles — defaults are seeded
   * once (via `ensureDefault*Profiles`) and the import flow assigns them
   * automatically. A media reaching this code without a profile yields an
   * empty allowed set; the search/grab pipelines treat that as "skip /
   * refuse to act". The same rule applies to both quality and language.
   */
  resolveAllowedForMedia(media: {
    qualityProfile?: QualityProfile | null;
    languageProfile?: LanguageProfile | null;
  }): { allowed: Set<number>; allowedLangs: Set<number> } {
    return {
      allowed: buildAllowedQualityIds(media.qualityProfile?.items),
      allowedLangs: allowedAudioLanguageIds(
        media.languageProfile?.audioLanguages,
      ),
    };
  }

  /**
   * Strict variant for the manual grab paths: throws `BadRequest` when the
   * quality profile is missing or empty. Language profile is treated as
   * optional — a null profile yields an empty `allowedLangs` set (permissive)
   * so the manual "Search releases" button doesn't break on media
   * imported before language profiles were always assigned. The auto
   * SearchMissing pipeline uses the non-throwing variant and refuses to
   * act on missing-profile rows via `classifyForSearch`.
   */
  resolveAllowedForMediaOrThrow(
    media: {
      qualityProfile?: QualityProfile | null;
      languageProfile?: LanguageProfile | null;
    },
    noun: 'movie' | 'series',
  ): { allowed: Set<number>; allowedLangs: Set<number> } {
    if (!media.qualityProfile) {
      throw new BadRequestException(
        `Assign a quality profile with at least one allowed quality to this ${noun}`,
      );
    }
    const sets = this.resolveAllowedForMedia(media);
    if (!sets.allowed.size) {
      throw new BadRequestException(
        `Assign a quality profile with at least one allowed quality to this ${noun}`,
      );
    }
    return sets;
  }

  async resolveLanguageProfileIdForImport(
    requested?: number,
  ): Promise<number | null> {
    await this.ensureDefaultLanguageProfiles();
    if (requested != null) {
      const p = await this.lpRepo.findOne({ where: { id: requested } });
      if (!p) {
        throw new BadRequestException(
          `Language profile #${requested} not found`,
        );
      }
      return p.id;
    }
    const [first] = await this.lpRepo.find({
      order: { id: 'ASC' },
      take: 1,
    });
    return first?.id ?? null;
  }

  async createQualityProfile(
    dto: CreateQualityProfileDto,
  ): Promise<QualityProfile> {
    const profile = this.qpRepo.create({
      name: dto.name,
      cutoff: dto.cutoff,
      upgradeAllowed: dto.upgradeAllowed ?? false,
      resolutionUpgradeOnly: dto.resolutionUpgradeOnly ?? false,
      items: dto.items.map((i) => ({
        quality: {
          id: i.qualityId,
          name: i.qualityName,
          resolution: i.resolution,
          source: i.source,
        },
        allowed: i.allowed,
        sortOrder: i.sortOrder,
        groupId: i.groupId ?? undefined,
      })),
    });
    return this.qpRepo.save(profile);
  }

  findAllQualityProfiles(): Promise<QualityProfile[]> {
    return this.qpRepo.find({ order: { name: 'ASC' } });
  }

  async findOneQualityProfile(id: number): Promise<QualityProfile> {
    const profile = await this.qpRepo.findOne({ where: { id } });
    if (!profile)
      throw new NotFoundException(`QualityProfile #${id} not found`);
    return profile;
  }

  async updateQualityProfile(
    id: number,
    dto: CreateQualityProfileDto,
  ): Promise<QualityProfile> {
    const profile = await this.findOneQualityProfile(id);
    profile.name = dto.name;
    profile.cutoff = dto.cutoff;
    profile.upgradeAllowed = dto.upgradeAllowed ?? profile.upgradeAllowed;
    profile.resolutionUpgradeOnly =
      dto.resolutionUpgradeOnly ?? profile.resolutionUpgradeOnly;
    profile.items = dto.items.map((i) => ({
      quality: {
        id: i.qualityId,
        name: i.qualityName,
        resolution: i.resolution,
        source: i.source,
      },
      allowed: i.allowed,
      sortOrder: i.sortOrder,
      groupId: i.groupId ?? undefined,
    }));
    return this.qpRepo.save(profile);
  }

  async removeQualityProfile(id: number): Promise<void> {
    const profile = await this.findOneQualityProfile(id);
    await this.qpRepo.remove(profile);
  }

  async createLanguageProfile(
    dto: CreateLanguageProfileDto,
  ): Promise<LanguageProfile> {
    const profile = this.lpRepo.create({
      name: dto.name,
      audioLanguages: dto.audioLanguages ?? [],
      subtitleLanguages: dto.subtitleLanguages ?? [],
    });
    return this.lpRepo.save(profile);
  }

  findAllLanguageProfiles(): Promise<LanguageProfile[]> {
    return this.lpRepo.find({ order: { name: 'ASC' } });
  }

  async findOneLanguageProfile(id: number): Promise<LanguageProfile> {
    const profile = await this.lpRepo.findOne({ where: { id } });
    if (!profile)
      throw new NotFoundException(`LanguageProfile #${id} not found`);
    return profile;
  }

  // ---------------------------------------------------------------------------
  // Cross-profile encompassment (used by request auto-approval + by the
  // "an admin imported with profile X, does it satisfy a user requesting Y?"
  // check at import time).
  // ---------------------------------------------------------------------------

  /** True when `existingId` covers everything `requestedId` asks for —
   *  same profile or `existing`'s cutoff resolution ≥ requested's (e.g.
   *  2160p covers 1080p). `null` on the existing side never covers a
   *  specific request; `null` on the requested side is trivially covered
   *  by the caller. */
  async qualityProfileCovers(
    existingId: number | null,
    requestedId: number,
  ): Promise<boolean> {
    if (existingId == null) return false;
    if (existingId === requestedId) return true;
    const [a, b] = await Promise.all([
      this.findOneQualityProfile(existingId).catch(() => null),
      this.findOneQualityProfile(requestedId).catch(() => null),
    ]);
    if (!a || !b) return false;
    return cutoffResolution(a) >= cutoffResolution(b);
  }

  /** True when every audio language of `requestedId` is also in
   *  `existingId`. Subtitles aren't compared — audio drives whether a
   *  user can actually watch the requested track. */
  async languageProfileCovers(
    existingId: number | null,
    requestedId: number,
  ): Promise<boolean> {
    if (existingId == null) return false;
    if (existingId === requestedId) return true;
    const [a, b] = await Promise.all([
      this.findOneLanguageProfile(existingId).catch(() => null),
      this.findOneLanguageProfile(requestedId).catch(() => null),
    ]);
    if (!a || !b) return false;
    const haves = new Set(a.audioLanguages.map((l) => l.isoCode));
    return b.audioLanguages.every((l) => haves.has(l.isoCode));
  }

  /** Profile-envelope cover: combines quality + language. `null` on the
   *  requested side means "no requirement on that axis" → satisfied. */
  async envelopeCovers(
    existing: { qualityProfileId: number | null; languageProfileId: number | null },
    requested: { qualityProfileId: number | null; languageProfileId: number | null },
  ): Promise<boolean> {
    if (
      requested.qualityProfileId != null &&
      !(await this.qualityProfileCovers(
        existing.qualityProfileId,
        requested.qualityProfileId,
      ))
    ) {
      return false;
    }
    if (
      requested.languageProfileId != null &&
      !(await this.languageProfileCovers(
        existing.languageProfileId,
        requested.languageProfileId,
      ))
    ) {
      return false;
    }
    return true;
  }

  async updateLanguageProfile(
    id: number,
    dto: CreateLanguageProfileDto,
  ): Promise<LanguageProfile> {
    const profile = await this.findOneLanguageProfile(id);
    profile.name = dto.name;
    profile.audioLanguages = dto.audioLanguages ?? [];
    profile.subtitleLanguages = dto.subtitleLanguages ?? [];
    return this.lpRepo.save(profile);
  }

  async removeLanguageProfile(id: number): Promise<void> {
    const profile = await this.findOneLanguageProfile(id);
    await this.lpRepo.remove(profile);
  }
}

/** Resolve a quality profile's cutoff to its resolution. Falls back to 0
 *  when the cutoff item isn't found so the profile reads as "lowest". */
function cutoffResolution(profile: QualityProfile): number {
  return (
    profile.items.find((i) => i.quality.id === profile.cutoff)?.quality
      .resolution ?? 0
  );
}
