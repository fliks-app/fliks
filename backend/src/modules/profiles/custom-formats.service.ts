import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CustomFormat, CustomFormatSpecification } from './entities/custom-format.entity';
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
   * Compute the total custom-format score for a release title.
   * Used in the grab flow to rank releases beyond basic quality.
   */
  async scoreRelease(releaseTitle: string): Promise<number> {
    const formats = await this.findAll();
    let total = 0;
    for (const fmt of formats) {
      if (this.matchesFormat(releaseTitle, fmt)) {
        total += fmt.score;
      }
    }
    return total;
  }

  private matchesFormat(title: string, fmt: CustomFormat): boolean {
    const titleLower = title.toLowerCase();
    let allRequiredMet = true;
    let anyNonRequiredMet = false;
    let hasNonRequired = false;

    for (const spec of fmt.specifications) {
      const match = this.evalSpec(titleLower, spec);
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

  private evalSpec(titleLower: string, spec: CustomFormatSpecification): boolean {
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
      default:
        return false;
    }
  }
}
