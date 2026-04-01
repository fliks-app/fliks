import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { QualityDefinition } from './entities/quality-definition.entity';
import { SUITARR_QUALITIES } from '../../common/constants/suitarr-qualities';
import { QualityDefinitionItemDto } from './dto/update-quality-definitions.dto';

/**
 * Default size limits in MB/h by resolution + source.
 * Typical bitrates per quality tier:
 *   480p: ~500-1500 MB/h
 *   720p: ~1000-3000 MB/h
 *   1080p: ~2000-8000 MB/h (WEB ~2-4 GB/h, Bluray ~4-8 GB/h, Remux ~15-25 GB/h)
 *   2160p: ~4000-20000 MB/h (WEB ~4-8 GB/h, Bluray ~10-20 GB/h, Remux ~30-60 GB/h)
 */
const DEFAULTS: Record<
  string,
  { min: number; preferred: number; max: number }
> = {
  // Low quality / unknown
  '0': { min: 0, preferred: 700, max: 1500 },
  // 480p
  '480': { min: 0, preferred: 800, max: 1500 },
  // 720p
  '720-hdtv': { min: 0, preferred: 1200, max: 2500 },
  '720-web': { min: 0, preferred: 1500, max: 3000 },
  '720-bluray': { min: 0, preferred: 2500, max: 5000 },
  '720': { min: 0, preferred: 1500, max: 3500 },
  // 1080p
  '1080-hdtv': { min: 0, preferred: 2000, max: 4000 },
  '1080-web': { min: 0, preferred: 3000, max: 5000 },
  '1080-bluray': { min: 0, preferred: 5000, max: 10000 },
  '1080-remux': { min: 0, preferred: 18000, max: 30000 },
  '1080': { min: 0, preferred: 3000, max: 6000 },
  // 2160p
  '2160-hdtv': { min: 0, preferred: 4000, max: 8000 },
  '2160-web': { min: 0, preferred: 6000, max: 12000 },
  '2160-bluray': { min: 0, preferred: 12000, max: 25000 },
  '2160-remux': { min: 0, preferred: 35000, max: 60000 },
  '2160': { min: 0, preferred: 8000, max: 20000 },
};

function getDefault(
  resolution: number,
  source: string,
): { min: number; preferred: number; max: number } {
  return (
    DEFAULTS[`${resolution}-${source}`] ??
    DEFAULTS[`${resolution}`] ??
    DEFAULTS['0']
  );
}

@Injectable()
export class QualityDefinitionsService {
  private readonly log = new Logger(QualityDefinitionsService.name);

  constructor(
    @InjectRepository(QualityDefinition)
    private readonly repo: Repository<QualityDefinition>,
  ) {}

  async ensureDefaults(): Promise<void> {
    if ((await this.repo.count()) > 0) return;

    const entities = SUITARR_QUALITIES.map((q) => {
      const def = getDefault(q.resolution, q.source);
      return this.repo.create({
        qualityId: q.id,
        title: q.name,
        minSize: def.min,
        preferredSize: def.preferred,
        maxSize: def.max,
      });
    });

    await this.repo.save(entities);
    this.log.log(`Seeded ${entities.length} quality definitions`);
  }

  /** Returns default values for all qualities without saving them. */
  async getDefaults(): Promise<QualityDefinition[]> {
    const existing = await this.findAll();
    return existing.map((d) => {
      const q = SUITARR_QUALITIES.find((sq) => sq.id === d.qualityId);
      const def = q ? getDefault(q.resolution, q.source) : getDefault(0, '');
      return {
        ...d,
        minSize: def.min,
        preferredSize: def.preferred,
        maxSize: def.max,
      };
    });
  }

  async findAll(): Promise<QualityDefinition[]> {
    await this.ensureDefaults();
    return this.repo.find({ order: { qualityId: 'ASC' } });
  }

  async updateAll(
    items: QualityDefinitionItemDto[],
  ): Promise<QualityDefinition[]> {
    await this.ensureDefaults();

    for (const item of items) {
      await this.repo.update(
        { qualityId: item.qualityId },
        {
          title: item.title,
          minSize: item.minSize,
          preferredSize: item.preferredSize,
          maxSize: item.maxSize,
        },
      );
    }

    return this.findAll();
  }

  async getSizeLimitsMap(): Promise<
    Map<number, { min: number; preferred: number; max: number }>
  > {
    const defs = await this.findAll();
    return new Map(
      defs.map((d) => [
        d.qualityId,
        { min: d.minSize, preferred: d.preferredSize, max: d.maxSize },
      ]),
    );
  }
}
