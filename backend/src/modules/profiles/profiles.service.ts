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

  async resolveQualityProfileIdForImport(
    requested?: number,
  ): Promise<number | null> {
    await this.ensureDefaultQualityProfiles();
    if (requested != null) {
      const p = await this.qpRepo.findOne({ where: { id: requested } });
      if (!p) {
        throw new BadRequestException(`Quality profile #${requested} not found`);
      }
      return p.id;
    }
    const first = await this.qpRepo.findOne({ order: { id: 'ASC' } });
    return first?.id ?? null;
  }

  async createQualityProfile(dto: CreateQualityProfileDto): Promise<QualityProfile> {
    const profile = this.qpRepo.create({
      name: dto.name,
      cutoff: dto.cutoff,
      upgradeAllowed: dto.upgradeAllowed ?? false,
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
    if (!profile) throw new NotFoundException(`QualityProfile #${id} not found`);
    return profile;
  }

  async updateQualityProfile(id: number, dto: CreateQualityProfileDto): Promise<QualityProfile> {
    const profile = await this.findOneQualityProfile(id);
    profile.name = dto.name;
    profile.cutoff = dto.cutoff;
    profile.upgradeAllowed = dto.upgradeAllowed ?? profile.upgradeAllowed;
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

  async createLanguageProfile(dto: CreateLanguageProfileDto): Promise<LanguageProfile> {
    const profile = this.lpRepo.create({
      name: dto.name,
      cutoff: dto.cutoff,
      languages: dto.languages.map((l) => ({
        language: {
          id: l.languageId,
          name: l.languageName,
          isoCode: l.isoCode,
        },
        allowed: l.allowed,
        sortOrder: l.sortOrder,
      })),
    });
    return this.lpRepo.save(profile);
  }

  findAllLanguageProfiles(): Promise<LanguageProfile[]> {
    return this.lpRepo.find({ order: { name: 'ASC' } });
  }

  async findOneLanguageProfile(id: number): Promise<LanguageProfile> {
    const profile = await this.lpRepo.findOne({ where: { id } });
    if (!profile) throw new NotFoundException(`LanguageProfile #${id} not found`);
    return profile;
  }

  async updateLanguageProfile(id: number, dto: CreateLanguageProfileDto): Promise<LanguageProfile> {
    const profile = await this.findOneLanguageProfile(id);
    profile.name = dto.name;
    profile.cutoff = dto.cutoff;
    profile.languages = dto.languages.map((l) => ({
      language: {
        id: l.languageId,
        name: l.languageName,
        isoCode: l.isoCode,
      },
      allowed: l.allowed,
      sortOrder: l.sortOrder,
    }));
    return this.lpRepo.save(profile);
  }

  async removeLanguageProfile(id: number): Promise<void> {
    const profile = await this.findOneLanguageProfile(id);
    await this.lpRepo.remove(profile);
  }
}
