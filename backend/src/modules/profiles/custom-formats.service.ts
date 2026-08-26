import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  CustomFormat,
  CustomFormatSpecification,
} from './entities/custom-format.entity';
import { CreateCustomFormatDto } from './dto/create-custom-format.dto';

@Injectable()
export class CustomFormatsService {
  constructor(
    @InjectRepository(CustomFormat)
    private readonly repo: Repository<CustomFormat>,
  ) {}

  create(dto: CreateCustomFormatDto): Promise<CustomFormat> {
    const row = this.repo.create({
      name: dto.name,
      score: dto.score ?? 0,
      specifications: (dto.specifications ?? []) as CustomFormatSpecification[],
    });
    return this.repo.save(row);
  }

  findAll(): Promise<CustomFormat[]> {
    return this.repo.find({ order: { name: 'ASC' } });
  }

  async findOne(id: number): Promise<CustomFormat> {
    const cf = await this.repo.findOne({ where: { id } });
    if (!cf) throw new NotFoundException(`Custom format #${id} not found`);
    return cf;
  }

  async update(id: number, dto: CreateCustomFormatDto): Promise<CustomFormat> {
    const cf = await this.findOne(id);
    if (dto.name !== undefined) cf.name = dto.name;
    if (dto.score !== undefined) cf.score = dto.score;
    if (dto.specifications !== undefined)
      cf.specifications = dto.specifications as CustomFormatSpecification[];
    return this.repo.save(cf);
  }

  async remove(id: number): Promise<void> {
    const cf = await this.findOne(id);
    await this.repo.remove(cf);
  }

  /**
   * Test a release title against all custom formats and return a breakdown.
   */
  async testRelease(
    title: string,
    meta?: { freeleech?: boolean; downloadVolumeFactor?: number },
  ): Promise<
    { formatId: number; formatName: string; matched: boolean; score: number }[]
  > {
    const formats = await this.repo.find();
    return formats.map((cf) => ({
      formatId: cf.id,
      formatName: cf.name,
      matched: this.matchesFormat(title, cf, meta),
      score: this.matchesFormat(title, cf, meta) ? cf.score : 0,
    }));
  }

  /**
   * Compute the total custom-format score for a release title.
   * Used in the grab flow to rank releases beyond basic quality.
   */
  async scoreRelease(
    releaseTitle: string,
    meta?: { freeleech?: boolean; downloadVolumeFactor?: number },
  ): Promise<number> {
    return this.scoreReleaseWith(await this.findAll(), releaseTitle, meta);
  }

  /** Same scoring against a format list the caller already read. The release scorer
   *  runs this once per candidate, so re-reading the table per release is an N+1. */
  scoreReleaseWith(
    formats: CustomFormat[],
    releaseTitle: string,
    meta?: { freeleech?: boolean; downloadVolumeFactor?: number },
  ): number {
    let total = 0;
    for (const fmt of formats) {
      if (this.matchesFormat(releaseTitle, fmt, meta)) {
        total += fmt.score;
      }
    }
    return total;
  }

  private matchesFormat(
    title: string,
    fmt: CustomFormat,
    meta?: { freeleech?: boolean; downloadVolumeFactor?: number },
  ): boolean {
    const titleLower = title.toLowerCase();
    let allRequiredMet = true;
    let anyNonRequiredMet = false;
    let hasNonRequired = false;

    for (const spec of fmt.specifications) {
      const match = this.evalSpec(titleLower, spec, meta);
      const result = spec.negate ? !match : match;

      if (spec.required) {
        if (!result) allRequiredMet = false;
      } else {
        hasNonRequired = true;
        if (result) anyNonRequiredMet = true;
      }
    }

    if (!allRequiredMet) return false;
    if (hasNonRequired && !anyNonRequiredMet) return false;
    return true;
  }

  private evalSpec(
    titleLower: string,
    spec: CustomFormatSpecification,
    meta?: { freeleech?: boolean; downloadVolumeFactor?: number },
  ): boolean {
    const val = (spec.value || '').toLowerCase();
    switch (spec.implementation) {
      case 'title_regex':
        try {
          return new RegExp(spec.value, 'i').test(titleLower);
        } catch {
          return false;
        }
      case 'source':
        return titleLower.includes(val);
      case 'resolution':
        return titleLower.includes(val);
      case 'language':
        return titleLower.includes(val);
      case 'release_flag':
        if (val === 'freeleech') return meta?.freeleech === true;
        if (val === 'halfleech') return meta?.downloadVolumeFactor === 0.5;
        return false;
      default:
        return false;
    }
  }
}
