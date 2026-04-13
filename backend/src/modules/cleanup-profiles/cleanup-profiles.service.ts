import { Injectable, NotFoundException, OnModuleInit, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CleanupProfile } from './entities/cleanup-profile.entity';
import { UpdateCleanupProfileDto } from './dto/update-cleanup-profile.dto';
import {
  STALLED_CLEANUP_PROFILE_DEFAULTS,
  STALLED_CLEANUP_PROFILE_KEYS,
  StalledCleanupProfileKey,
} from '../../common/constants/stalled-cleanup-profiles';

@Injectable()
export class CleanupProfilesService implements OnModuleInit {
  private readonly log = new Logger(CleanupProfilesService.name);

  constructor(
    @InjectRepository(CleanupProfile)
    private readonly repo: Repository<CleanupProfile>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.seedDefaults();
  }

  /**
   * Ensures the three fixed profile rows (fast/medium/slow) exist in DB.
   * Missing rows are inserted with their default values; existing rows are untouched.
   */
  private async seedDefaults(): Promise<void> {
    for (const key of STALLED_CLEANUP_PROFILE_KEYS) {
      const existing = await this.repo.findOne({ where: { key } });
      if (existing) continue;
      const defaults = STALLED_CLEANUP_PROFILE_DEFAULTS[key];
      await this.repo.save(this.repo.create({ key, ...defaults }));
      this.log.log(`Seeded cleanup profile "${key}"`);
    }
  }

  findAll(): Promise<CleanupProfile[]> {
    return this.repo.find();
  }

  async findOne(key: StalledCleanupProfileKey): Promise<CleanupProfile> {
    const row = await this.repo.findOne({ where: { key } });
    if (!row) throw new NotFoundException(`Cleanup profile "${key}" not found`);
    return row;
  }

  async update(
    key: StalledCleanupProfileKey,
    dto: UpdateCleanupProfileDto,
  ): Promise<CleanupProfile> {
    const row = await this.findOne(key);
    if (dto.samples !== undefined) row.samples = dto.samples;
    if (dto.intervalMinutes !== undefined) row.intervalMinutes = dto.intervalMinutes;
    if (dto.autoRestart !== undefined) row.autoRestart = dto.autoRestart;
    return this.repo.save(row);
  }
}
