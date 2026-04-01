import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { QualityDefinition } from './entities/quality-definition.entity';
import { SUITARR_QUALITIES } from '../../common/constants/suitarr-qualities';
import { QualityDefinitionItemDto } from './dto/update-quality-definitions.dto';

/** Default preferred sizes in MB/h by resolution. */
const DEFAULTS: Record<
  number,
  { min: number; preferred: number; max: number }
> = {
  0: { min: 0, preferred: 95, max: 100 },
  480: { min: 0, preferred: 95, max: 100 },
  720: { min: 0, preferred: 137.3, max: 162.2 },
  1080: { min: 0, preferred: 137.3, max: 227.9 },
  2160: { min: 0, preferred: 302.5, max: 400 },
};

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
      const def = DEFAULTS[q.resolution] ?? DEFAULTS[0];
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
